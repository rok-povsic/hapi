import { Hono } from 'hono'
import { z } from 'zod'
import type { WebAppEnv } from '../middleware/auth'
import {
    DEFAULT_VOICE_STT_MODEL_ID,
    DEFAULT_VOICE_TTS_MODEL_ID,
    DEFAULT_VOICE_TTS_VOICE_ID,
    ELEVENLABS_API_BASE,
    VOICE_AGENT_NAME,
    buildVoiceAgentConfig
} from '@hapi/protocol/voice'

const tokenRequestSchema = z.object({
    customAgentId: z.string().optional(),
    customApiKey: z.string().optional()
})

const speechRequestSchema = z.object({
    text: z.string().trim().min(1).max(12_000),
    voiceId: z.string().trim().min(1).optional(),
    modelId: z.string().trim().min(1).optional(),
    customApiKey: z.string().trim().min(1).optional()
})

const transcribeFieldsSchema = z.object({
    modelId: z.string().trim().min(1).optional(),
    languageCode: z.string().trim().min(1).optional(),
    customApiKey: z.string().trim().min(1).optional()
})

// Cache for auto-created agent IDs (keyed by API key hash)
const agentIdCache = new Map<string, string>()

interface ElevenLabsAgent {
    agent_id: string
    name: string
}

function getOptionalFormString(formData: FormData, key: string): string | undefined {
    const value = formData.get(key)
    return typeof value === 'string' && value.trim() ? value : undefined
}

function resolveApiKey(customApiKey?: string): string | null {
    return customApiKey || process.env.ELEVENLABS_API_KEY || null
}

function resolveTtsVoiceId(override?: string): string {
    return override || process.env.ELEVENLABS_TTS_VOICE_ID || DEFAULT_VOICE_TTS_VOICE_ID
}

function resolveTtsModelId(override?: string): string {
    return override || process.env.ELEVENLABS_TTS_MODEL_ID || DEFAULT_VOICE_TTS_MODEL_ID
}

function resolveSttModelId(override?: string): string {
    return override || process.env.ELEVENLABS_STT_MODEL_ID || DEFAULT_VOICE_STT_MODEL_ID
}

async function readElevenLabsError(response: Response): Promise<string> {
    const contentType = response.headers.get('content-type') || ''
    if (contentType.includes('application/json')) {
        const errorData = await response.json().catch(() => ({})) as {
            detail?: { message?: string } | string
            error?: string
            message?: string
        }
        if (typeof errorData.detail === 'string' && errorData.detail.trim()) {
            return errorData.detail
        }
        if (typeof errorData.detail === 'object' && errorData.detail?.message) {
            return errorData.detail.message
        }
        if (typeof errorData.error === 'string' && errorData.error.trim()) {
            return errorData.error
        }
        if (typeof errorData.message === 'string' && errorData.message.trim()) {
            return errorData.message
        }
    }

    const body = await response.text().catch(() => '')
    return body.trim() || `ElevenLabs API error: ${response.status}`
}

/**
 * Find an existing "Hapi Voice Assistant" agent
 */
async function findHapiAgent(apiKey: string): Promise<string | null> {
    try {
        const response = await fetch(`${ELEVENLABS_API_BASE}/convai/agents`, {
            method: 'GET',
            headers: {
                'xi-api-key': apiKey,
                'Accept': 'application/json'
            }
        })

        if (!response.ok) {
            return null
        }

        const data = await response.json() as { agents?: ElevenLabsAgent[] }
        const agents: ElevenLabsAgent[] = data.agents || []
        const hapiAgent = agents.find(agent => agent.name === VOICE_AGENT_NAME)

        return hapiAgent?.agent_id || null
    } catch {
        return null
    }
}

/**
 * Create a new "Hapi Voice Assistant" agent
 */
async function createHapiAgent(apiKey: string): Promise<string | null> {
    try {
        const response = await fetch(`${ELEVENLABS_API_BASE}/convai/agents/create`, {
            method: 'POST',
            headers: {
                'xi-api-key': apiKey,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify(buildVoiceAgentConfig())
        })

        if (!response.ok) {
            console.error('[Voice] Failed to create agent:', await readElevenLabsError(response))
            return null
        }

        const data = await response.json() as { agent_id?: string }
        return data.agent_id || null
    } catch (error) {
        console.error('[Voice] Error creating agent:', error)
        return null
    }
}

/**
 * Get or create agent ID - finds existing or creates new "Hapi Voice Assistant" agent
 */
async function getOrCreateAgentId(apiKey: string): Promise<string | null> {
    const cacheKey = `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`
    const cached = agentIdCache.get(cacheKey)
    if (cached) {
        return cached
    }

    console.log('[Voice] No agent ID configured, searching for existing agent...')
    let agentId = await findHapiAgent(apiKey)

    if (agentId) {
        console.log('[Voice] Found existing agent:', agentId)
    } else {
        console.log('[Voice] No existing agent found, creating new one...')
        agentId = await createHapiAgent(apiKey)
        if (agentId) {
            console.log('[Voice] Created new agent:', agentId)
        }
    }

    if (agentId) {
        agentIdCache.set(cacheKey, agentId)
    }

    return agentId
}

export function createVoiceRoutes(): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    // Get ElevenLabs ConvAI conversation token
    app.post('/voice/token', async (c) => {
        const json = await c.req.json().catch(() => null)
        const parsed = tokenRequestSchema.safeParse(json ?? {})
        if (!parsed.success) {
            return c.json({ allowed: false, error: 'Invalid request body' }, 400)
        }

        const { customAgentId, customApiKey } = parsed.data
        const apiKey = resolveApiKey(customApiKey)
        let agentId = customAgentId || process.env.ELEVENLABS_AGENT_ID

        if (!apiKey) {
            return c.json({
                allowed: false,
                error: 'ElevenLabs API key not configured'
            }, 400)
        }

        if (!agentId) {
            agentId = await getOrCreateAgentId(apiKey) ?? undefined
            if (!agentId) {
                return c.json({
                    allowed: false,
                    error: 'Failed to create ElevenLabs agent automatically'
                }, 500)
            }
        }

        try {
            const response = await fetch(
                `${ELEVENLABS_API_BASE}/convai/conversation/token?agent_id=${encodeURIComponent(agentId)}`,
                {
                    method: 'GET',
                    headers: {
                        'xi-api-key': apiKey,
                        'Accept': 'application/json'
                    }
                }
            )

            if (!response.ok) {
                const errorMessage = await readElevenLabsError(response)
                console.error('[Voice] Failed to get token from ElevenLabs:', errorMessage)
                return c.json({
                    allowed: false,
                    error: errorMessage
                }, 500)
            }

            const data = await response.json() as { token?: string }
            if (!data.token) {
                return c.json({
                    allowed: false,
                    error: 'No token in ElevenLabs response'
                }, 500)
            }

            return c.json({
                allowed: true,
                token: data.token,
                agentId
            })
        } catch (error) {
            console.error('[Voice] Error fetching token:', error)
            return c.json({
                allowed: false,
                error: error instanceof Error ? error.message : 'Network error'
            }, 500)
        }
    })

    app.post('/voice/transcribe', async (c) => {
        const formData = await c.req.raw.formData().catch(() => null)
        if (!formData) {
            return c.json({ success: false, error: 'Invalid form data' }, 400)
        }

        const audio = formData.get('audio')
        if (!(audio instanceof File)) {
            return c.json({ success: false, error: 'Missing audio file' }, 400)
        }

        const parsed = transcribeFieldsSchema.safeParse({
            modelId: getOptionalFormString(formData, 'modelId'),
            languageCode: getOptionalFormString(formData, 'languageCode'),
            customApiKey: getOptionalFormString(formData, 'customApiKey')
        })
        if (!parsed.success) {
            return c.json({ success: false, error: 'Invalid transcription request' }, 400)
        }

        const apiKey = resolveApiKey(parsed.data.customApiKey)
        if (!apiKey) {
            return c.json({ success: false, error: 'ElevenLabs API key not configured' }, 400)
        }

        const elevenFormData = new FormData()
        elevenFormData.set('model_id', resolveSttModelId(parsed.data.modelId))
        elevenFormData.set('file', audio, audio.name || 'recording.webm')
        if (parsed.data.languageCode) {
            elevenFormData.set('language_code', parsed.data.languageCode)
        }

        try {
            const response = await fetch(`${ELEVENLABS_API_BASE}/speech-to-text`, {
                method: 'POST',
                headers: {
                    'xi-api-key': apiKey,
                    'Accept': 'application/json'
                },
                body: elevenFormData
            })

            if (!response.ok) {
                const errorMessage = await readElevenLabsError(response)
                console.error('[Voice] Failed to transcribe audio:', errorMessage)
                return c.json({ success: false, error: errorMessage }, 500)
            }

            const data = await response.json() as { text?: string }
            const text = data.text?.trim()
            if (!text) {
                return c.json({ success: false, error: 'No transcript returned' }, 500)
            }

            return c.json({ success: true, text })
        } catch (error) {
            console.error('[Voice] Error transcribing audio:', error)
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Network error'
            }, 500)
        }
    })

    app.post('/voice/speak', async (c) => {
        const json = await c.req.json().catch(() => null)
        const parsed = speechRequestSchema.safeParse(json ?? {})
        if (!parsed.success) {
            return c.json({ success: false, error: 'Invalid request body' }, 400)
        }

        const apiKey = resolveApiKey(parsed.data.customApiKey)
        if (!apiKey) {
            return c.json({ success: false, error: 'ElevenLabs API key not configured' }, 400)
        }

        try {
            const response = await fetch(
                `${ELEVENLABS_API_BASE}/text-to-speech/${encodeURIComponent(resolveTtsVoiceId(parsed.data.voiceId))}`,
                {
                    method: 'POST',
                    headers: {
                        'xi-api-key': apiKey,
                        'Accept': 'audio/mpeg',
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        text: parsed.data.text,
                        model_id: resolveTtsModelId(parsed.data.modelId),
                        output_format: 'mp3_44100_128'
                    })
                }
            )

            if (!response.ok || !response.body) {
                const errorMessage = await readElevenLabsError(response)
                console.error('[Voice] Failed to synthesize speech:', errorMessage)
                return c.json({ success: false, error: errorMessage }, 500)
            }

            return new Response(response.body, {
                status: 200,
                headers: {
                    'Content-Type': response.headers.get('content-type') || 'audio/mpeg',
                    'Cache-Control': 'no-store'
                }
            })
        } catch (error) {
            console.error('[Voice] Error synthesizing speech:', error)
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Network error'
            }, 500)
        }
    })

    return app
}
