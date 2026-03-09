import { isObject } from '@hapi/protocol'
import { unwrapRoleWrappedRecordEnvelope } from '@hapi/protocol/messages'
import type { AgentStateRequest } from '@hapi/protocol/types'
import type { DecryptedMessage } from '@/types/api'

interface ContentItem {
    type: string
    text?: string
    name?: string
    input?: unknown
}

type NormalizedRole = 'assistant' | 'user'

function isContentArray(content: unknown): content is ContentItem[] {
    return Array.isArray(content)
}

function normalizeRole(role: string | null | undefined): NormalizedRole | null {
    if (role === 'agent' || role === 'assistant') return 'assistant'
    if (role === 'user') return 'user'
    return null
}

function unwrapRoleWrappedContent(message: DecryptedMessage): { role: NormalizedRole | null; content: unknown } {
    const record = unwrapRoleWrappedRecordEnvelope(message.content)
    if (!record) {
        return { role: null, content: message.content }
    }
    return { role: normalizeRole(record.role), content: record.content }
}

function unwrapOutputContent(content: unknown): { roleOverride: NormalizedRole | null; content: unknown } {
    if (!isObject(content) || content.type !== 'output') {
        return { roleOverride: null, content }
    }

    const data = isObject(content.data) ? content.data : null
    if (!data || typeof data.type !== 'string') {
        return { roleOverride: null, content }
    }

    const message = isObject(data.message) ? data.message : null
    if (!message) {
        return { roleOverride: null, content }
    }

    const messageContent = (message as { content?: unknown }).content
    if (typeof messageContent === 'undefined') {
        return { roleOverride: null, content }
    }

    const roleOverride = data.type === 'assistant'
        ? 'assistant'
        : data.type === 'user'
            ? 'user'
            : null

    return { roleOverride, content: messageContent }
}

function getAssistantTextParts(content: unknown, role: NormalizedRole | null): string[] {
    if (!isContentArray(content)) {
        if (role !== 'assistant') return []
        if (typeof content === 'string') {
            return [content.trim()].filter(Boolean)
        }
        if (isObject(content) && content.type === 'text' && typeof content.text === 'string') {
            return [content.text.trim()].filter(Boolean)
        }
        return []
    }

    const normalizedRole = role === 'assistant'
        ? 'assistant'
        : role === 'user'
            ? 'user'
            : content.some((item) => item.type === 'tool_use')
                ? 'assistant'
                : null

    if (normalizedRole !== 'assistant') {
        return []
    }

    return content
        .filter((item) => item.type === 'text' && typeof item.text === 'string')
        .map((item) => item.text?.trim() || '')
        .filter(Boolean)
}

function getString(record: unknown, ...keys: string[]): string | null {
    if (!isObject(record)) return null
    for (const key of keys) {
        const value = record[key]
        if (typeof value === 'string' && value.trim()) {
            return value.trim()
        }
    }
    return null
}

function quoteSnippet(value: string | null): string | null {
    if (!value) return null
    const trimmed = value.trim()
    if (!trimmed) return null
    const compact = trimmed.length > 160 ? `${trimmed.slice(0, 157)}...` : trimmed
    return `"${compact}"`
}

export function extractAssistantSpeechText(message: DecryptedMessage): string | null {
    const { role, content: wrappedContent } = unwrapRoleWrappedContent(message)
    const { roleOverride, content } = unwrapOutputContent(wrappedContent)
    const parts = getAssistantTextParts(content, roleOverride ?? role)
    if (parts.length === 0) {
        return null
    }
    return parts.join('\n\n')
}

export function buildPermissionSpeech(request: AgentStateRequest): string {
    const toolName = request.tool || 'unknown tool'
    const args = request.arguments

    if (toolName === 'Bash') {
        const command = quoteSnippet(getString(args, 'command', 'cmd', 'bash'))
        return command
            ? `Claude wants permission to run a bash command: ${command}`
            : 'Claude wants permission to run a bash command.'
    }

    if (toolName === 'Read') {
        const path = quoteSnippet(getString(args, 'file_path', 'path'))
        return path
            ? `Claude wants permission to read ${path}.`
            : 'Claude wants permission to read a file.'
    }

    if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit') {
        const path = quoteSnippet(getString(args, 'file_path', 'path'))
        return path
            ? `Claude wants permission to modify ${path}.`
            : 'Claude wants permission to modify a file.'
    }

    if (toolName === 'WebFetch') {
        const url = quoteSnippet(getString(args, 'url'))
        return url
            ? `Claude wants permission to fetch ${url}.`
            : 'Claude wants permission to fetch a URL.'
    }

    if (toolName === 'request_user_input' || toolName === 'AskUserQuestion') {
        const question = quoteSnippet(getString(args, 'question', 'prompt', 'message'))
        return question
            ? `Claude needs your input: ${question}`
            : 'Claude needs your input before it can continue.'
    }

    return `Claude wants permission to use ${toolName}.`
}
