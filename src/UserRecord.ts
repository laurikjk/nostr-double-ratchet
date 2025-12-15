import {
  DeviceRecord,
  StoredDeviceRecord,
  createDeviceRecord,
  serializeDeviceRecord,
  deserializeDeviceRecord,
} from "./DeviceRecord"
import { NostrSubscribe } from "./types"

export interface UserRecord {
  publicKey: string
  devices: Map<string, DeviceRecord>
}

export interface StoredUserRecord {
  publicKey: string
  devices: StoredDeviceRecord[]
}

export function createUserRecord(publicKey: string): UserRecord {
  return {
    publicKey,
    devices: new Map(),
  }
}

export function getOrCreateDevice(user: UserRecord, deviceId: string): DeviceRecord {
  let device = user.devices.get(deviceId)
  if (!device) {
    device = createDeviceRecord(deviceId)
    user.devices.set(deviceId, device)
  }
  return device
}

export function serializeUserRecord(user: UserRecord): StoredUserRecord {
  return {
    publicKey: user.publicKey,
    devices: Array.from(user.devices.values()).map((device) =>
      serializeDeviceRecord(device)
    ),
  }
}

export function deserializeUserRecord(
  data: StoredUserRecord,
  nostrSubscribe: NostrSubscribe
): UserRecord {
  const devices = new Map<string, DeviceRecord>()

  for (const deviceData of data.devices) {
    const deviceRecord = deserializeDeviceRecord(deviceData, nostrSubscribe)
    devices.set(deviceRecord.deviceId, deviceRecord)
  }

  return {
    publicKey: data.publicKey,
    devices,
  }
}
