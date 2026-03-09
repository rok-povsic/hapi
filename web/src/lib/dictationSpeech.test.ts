import { describe, expect, it } from 'vitest'
import type { AgentStateRequest } from '@hapi/protocol/types'
import type { DecryptedMessage } from '@/types/api'
import { buildPermissionSpeech, extractAssistantSpeechText } from './dictationSpeech'

describe('dictationSpeech', () => {
    it('extracts assistant text and ignores user messages', () => {
        const assistantMessage: DecryptedMessage = {
            id: 'assistant-1',
            seq: 2,
            localId: null,
            createdAt: 1,
            content: {
                role: 'assistant',
                content: [
                    { type: 'text', text: 'First paragraph.' },
                    { type: 'text', text: 'Second paragraph.' }
                ]
            }
        }

        const userMessage: DecryptedMessage = {
            id: 'user-1',
            seq: 1,
            localId: null,
            createdAt: 0,
            content: {
                role: 'user',
                content: [
                    { type: 'text', text: 'Hello there' }
                ]
            }
        }

        expect(extractAssistantSpeechText(assistantMessage)).toBe('First paragraph.\n\nSecond paragraph.')
        expect(extractAssistantSpeechText(userMessage)).toBeNull()
    })

    it('builds condensed permission narration for bash commands', () => {
        const request: AgentStateRequest = {
            tool: 'Bash',
            arguments: {
                command: 'npm test -- --runInBand'
            },
            createdAt: 0
        }

        expect(buildPermissionSpeech(request)).toBe(
            'Claude wants permission to run a bash command: "npm test -- --runInBand"'
        )
    })
})
