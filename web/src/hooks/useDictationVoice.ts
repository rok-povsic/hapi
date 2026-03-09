import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentStateRequest } from '@hapi/protocol/types'
import type { ApiClient } from '@/api/client'
import { buildPermissionSpeech, extractAssistantSpeechText } from '@/lib/dictationSpeech'
import type { DecryptedMessage, Session } from '@/types/api'

export type DictationStatus = 'idle' | 'recording' | 'transcribing' | 'speaking' | 'error'

interface DictationTurnState {
    afterSeq: number
    spokenMessageIds: Set<string>
    announcedRequestIds: Set<string>
}

function getPreferredRecordingMimeType(): string | undefined {
    if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
        return undefined
    }

    const candidates = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/mp4;codecs=mp4a.40.2',
        'audio/mp4'
    ]

    return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate))
}

function getFileExtension(mimeType: string): string {
    if (mimeType.includes('mp4')) return 'm4a'
    if (mimeType.includes('mpeg')) return 'mp3'
    if (mimeType.includes('ogg')) return 'ogg'
    return 'webm'
}

function getMaxSeq(messages: DecryptedMessage[]): number {
    let maxSeq = 0
    for (const message of messages) {
        if (typeof message.seq === 'number' && Number.isFinite(message.seq)) {
            maxSeq = Math.max(maxSeq, message.seq)
        }
    }
    return maxSeq
}

function playAudio(audio: HTMLAudioElement): Promise<void> {
    return new Promise((resolve, reject) => {
        audio.onended = () => resolve()
        audio.onerror = () => reject(new Error('Failed to play speech audio'))
        void audio.play().catch(reject)
    })
}

export function useDictationVoice(props: {
    api: ApiClient
    session: Session
    messages: DecryptedMessage[]
    onSend: (text: string) => void
}) {
    const [status, setStatus] = useState<DictationStatus>('idle')
    const [errorMessage, setErrorMessage] = useState<string | null>(null)

    const recorderRef = useRef<MediaRecorder | null>(null)
    const mediaStreamRef = useRef<MediaStream | null>(null)
    const recordedChunksRef = useRef<Blob[]>([])
    const audioRef = useRef<HTMLAudioElement | null>(null)
    const queueRef = useRef(Promise.resolve())
    const queueGenerationRef = useRef(0)
    const turnRef = useRef<DictationTurnState | null>(null)
    const prevThinkingRef = useRef(props.session.thinking)
    const messagesRef = useRef(props.messages)
    const startInFlightRef = useRef(false)
    const pendingStopRef = useRef(false)

    useEffect(() => {
        messagesRef.current = props.messages
    }, [props.messages])

    const clearRecorderResources = useCallback(() => {
        recorderRef.current = null
        const stream = mediaStreamRef.current
        mediaStreamRef.current = null
        if (stream) {
            stream.getTracks().forEach((track) => track.stop())
        }
        recordedChunksRef.current = []
    }, [])

    const resetSpeechQueue = useCallback(() => {
        queueGenerationRef.current += 1
        audioRef.current?.pause()
        audioRef.current = null
        queueRef.current = Promise.resolve()
        setStatus((current) => current === 'speaking' ? 'idle' : current)
    }, [])

    const fail = useCallback((message: string) => {
        setErrorMessage(message)
        setStatus('error')
    }, [])

    const dismissError = useCallback(() => {
        setErrorMessage(null)
        setStatus('idle')
    }, [])

    const enqueueSpeech = useCallback((text: string) => {
        const trimmed = text.trim()
        if (!trimmed) return

        const generation = queueGenerationRef.current
        queueRef.current = queueRef.current
            .catch(() => undefined)
            .then(async () => {
                if (generation !== queueGenerationRef.current) return

                setErrorMessage(null)
                setStatus('speaking')

                try {
                    const blob = await props.api.synthesizeVoiceSpeech(trimmed)
                    if (generation !== queueGenerationRef.current) return

                    const url = URL.createObjectURL(blob)
                    const audio = new Audio(url)
                    audioRef.current = audio

                    try {
                        await playAudio(audio)
                    } finally {
                        if (audioRef.current === audio) {
                            audioRef.current = null
                        }
                        URL.revokeObjectURL(url)
                    }
                } catch (error) {
                    if (generation !== queueGenerationRef.current) return
                    fail(error instanceof Error ? error.message : 'Failed to speak response')
                    return
                }

                if (generation === queueGenerationRef.current && audioRef.current === null) {
                    setStatus((current) => current === 'speaking' ? 'idle' : current)
                }
            })
    }, [fail, props.api])

    const stopRecording = useCallback(() => {
        const recorder = recorderRef.current
        if (!recorder || recorder.state === 'inactive') {
            pendingStopRef.current = true
            return
        }

        if (status === 'recording') {
            setStatus('transcribing')
        }
        recorder.stop()
    }, [status])

    const startRecording = useCallback(async () => {
        if (status === 'transcribing' || startInFlightRef.current) {
            return
        }

        resetSpeechQueue()
        turnRef.current = null
        setErrorMessage(null)
        pendingStopRef.current = false
        startInFlightRef.current = true

        if (typeof window === 'undefined' || typeof navigator === 'undefined') {
            startInFlightRef.current = false
            fail('Voice recording is not available here')
            return
        }

        if (typeof MediaRecorder === 'undefined') {
            startInFlightRef.current = false
            fail('Voice recording is not supported on this device')
            return
        }

        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            })

            const mimeType = getPreferredRecordingMimeType()
            const recorder = mimeType
                ? new MediaRecorder(stream, { mimeType })
                : new MediaRecorder(stream)

            mediaStreamRef.current = stream
            recorderRef.current = recorder
            recordedChunksRef.current = []

            recorder.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    recordedChunksRef.current.push(event.data)
                }
            }

            recorder.onerror = () => {
                clearRecorderResources()
                fail('Microphone recording failed')
            }

            recorder.onstop = async () => {
                const chunks = recordedChunksRef.current
                clearRecorderResources()

                if (chunks.length === 0) {
                    setStatus('idle')
                    return
                }

                try {
                    const blobType = recorder.mimeType || mimeType || 'audio/webm'
                    const blob = new Blob(chunks, { type: blobType })
                    const file = new File([blob], `dictation.${getFileExtension(blobType)}`, { type: blobType })
                    const result = await props.api.transcribeVoiceAudio(file)

                    if (!result.success || !result.text?.trim()) {
                        fail(result.error || 'No speech detected')
                        return
                    }

                    turnRef.current = {
                        afterSeq: getMaxSeq(messagesRef.current),
                        spokenMessageIds: new Set(),
                        announcedRequestIds: new Set()
                    }

                    props.onSend(result.text.trim())
                    setStatus('idle')
                } catch (error) {
                    fail(error instanceof Error ? error.message : 'Failed to transcribe recording')
                }
            }

            recorder.start()
            setStatus('recording')
            startInFlightRef.current = false

            if (pendingStopRef.current) {
                pendingStopRef.current = false
                setStatus('transcribing')
                recorder.stop()
            }
        } catch (error) {
            startInFlightRef.current = false
            fail(error instanceof Error ? error.message : 'Microphone permission denied')
        }
    }, [clearRecorderResources, fail, props.api, props.onSend, resetSpeechQueue, status])

    useEffect(() => {
        const requests = props.session.agentState?.requests ?? {}
        const turn = turnRef.current
        if (!turn) {
            return
        }

        for (const [requestId, request] of Object.entries(requests)) {
            if (turn.announcedRequestIds.has(requestId)) {
                continue
            }

            turn.announcedRequestIds.add(requestId)
            enqueueSpeech(buildPermissionSpeech(request as AgentStateRequest))
        }
    }, [enqueueSpeech, props.session.agentState?.requests])

    useEffect(() => {
        const wasThinking = prevThinkingRef.current
        prevThinkingRef.current = props.session.thinking

        const turn = turnRef.current
        if (!turn) {
            return
        }

        if (props.session.thinking) {
            return
        }

        if (wasThinking === false && status !== 'idle' && status !== 'speaking') {
            return
        }

        const assistantTexts = props.messages
            .filter((message) => (message.seq ?? 0) > turn.afterSeq && !turn.spokenMessageIds.has(message.id))
            .map((message) => ({
                id: message.id,
                text: extractAssistantSpeechText(message)
            }))
            .filter((entry) => Boolean(entry.text))

        if (assistantTexts.length === 0) {
            return
        }

        for (const entry of assistantTexts) {
            turn.spokenMessageIds.add(entry.id)
        }

        const spokenText = assistantTexts
            .map((entry) => entry.text?.trim() || '')
            .filter(Boolean)
            .join('\n\n')

        if (spokenText) {
            enqueueSpeech(spokenText)
        }

        turnRef.current = null
    }, [enqueueSpeech, props.messages, props.session.thinking, status])

    useEffect(() => {
        return () => {
            resetSpeechQueue()
            clearRecorderResources()
        }
    }, [clearRecorderResources, resetSpeechQueue])

    return {
        status,
        errorMessage,
        startRecording,
        stopRecording,
        dismissError,
        isRecording: status === 'recording'
    }
}
