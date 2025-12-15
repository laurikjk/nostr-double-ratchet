import { Session } from "./Session"
import { serializeSessionState, deserializeSessionState } from "./utils"
import { NostrSubscribe } from "./types"

export interface DeviceRecord {
  deviceId: string
  activeSession?: Session
  inactiveSessions: Session[]
  createdAt: number
  staleAt?: number
}

export type StoredSessionEntry = ReturnType<typeof serializeSessionState>

export interface StoredDeviceRecord {
  deviceId: string
  activeSession: StoredSessionEntry | null
  inactiveSessions: StoredSessionEntry[]
  createdAt: number
  staleAt?: number
}

export function createDeviceRecord(deviceId: string): DeviceRecord {
  return {
    deviceId,
    inactiveSessions: [],
    createdAt: Date.now(),
  }
}

export function serializeDeviceRecord(record: DeviceRecord): StoredDeviceRecord {
  return {
    deviceId: record.deviceId,
    activeSession: record.activeSession
      ? serializeSessionState(record.activeSession.state)
      : null,
    inactiveSessions: record.inactiveSessions.map((session) =>
      serializeSessionState(session.state)
    ),
    createdAt: record.createdAt,
    staleAt: record.staleAt,
  }
}

export function deserializeDeviceRecord(
  data: StoredDeviceRecord,
  nostrSubscribe: NostrSubscribe
): DeviceRecord {
  const activeSession = data.activeSession
    ? new Session(nostrSubscribe, deserializeSessionState(data.activeSession))
    : undefined

  const inactiveSessions = data.inactiveSessions.map(
    (entry) => new Session(nostrSubscribe, deserializeSessionState(entry))
  )

  return {
    deviceId: data.deviceId,
    activeSession,
    inactiveSessions,
    createdAt: data.createdAt,
    staleAt: data.staleAt,
  }
}

export function rotateSession(record: DeviceRecord, nextSession: Session): void {
  const current = record.activeSession

  if (!current) {
    record.activeSession = nextSession
    return
  }

  if (current === nextSession || current.name === nextSession.name) {
    record.activeSession = nextSession
    return
  }

  record.inactiveSessions = record.inactiveSessions.filter(
    (session) => session !== current && session.name !== current.name
  )

  record.inactiveSessions.push(current)
  record.inactiveSessions = record.inactiveSessions.slice(-1)
  record.activeSession = nextSession
}
