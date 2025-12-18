import { VerifiedEvent, UnsignedEvent, verifyEvent } from "nostr-tools";
import { INVITE_LIST_KIND, INVITE_RESPONSE_KIND, NostrSubscribe, Unsubscribe } from "./types";
import { Session } from "./Session";
import {
  generateEphemeralKeypair,
  generateSharedSecret,
  generateDeviceId,
  encryptInviteResponse,
  decryptInviteResponse,
  createSessionFromAccept,
} from "./inviteUtils";

/**
 * A device entry in the invite list.
 */
export interface DeviceEntry {
  /** Ephemeral public key for handshakes */
  ephemeralPublicKey: string;
  /** Shared secret for initial encryption */
  sharedSecret: string;
  /** Unique device identifier */
  deviceId: string;
  /** Human-readable device name */
  label: string;
  /** Private key (only available on the device that owns this entry) */
  ephemeralPrivateKey?: Uint8Array;
}

/**
 * A removed device entry with timestamp.
 */
export interface RemovedEntry {
  deviceId: string;
  timestamp: number;
}

/**
 * Parameters for accepting an invite from a device in the list.
 */
export interface AcceptParams {
  /** The device ID to accept the invite for */
  deviceId: string;
  /** The invitee's public key */
  inviteePublicKey: string;
  /** The invitee's private key */
  inviteePrivateKey: Uint8Array;
  /** Nostr subscription function */
  nostrSubscribe: NostrSubscribe;
  /** Optional device ID for the invitee's device */
  inviteeDeviceId?: string;
}

/**
 * Parameters for listening for invite acceptances.
 */
export interface ListenParams {
  /** The device ID to listen for acceptances on */
  deviceId: string;
  /** The owner's private key for decryption */
  ownerPrivateKey: Uint8Array;
  /** Nostr subscription function */
  nostrSubscribe: NostrSubscribe;
  /** Callback when a session is established */
  onSession: (session: Session, identity: string, inviteeDeviceId?: string) => void;
}

/**
 * InviteList manages a user's device invites in a single replaceable event (kind 10078).
 *
 * Unlike the per-device Invite class, InviteList consolidates all devices into one event,
 * enabling atomic updates and central authority (main device only can modify).
 */
export class InviteList {
  /** The owner's public key */
  owner: string;

  /** Active devices */
  private devices: Map<string, DeviceEntry> = new Map();

  /** Removed devices with timestamps */
  removed: RemovedEntry[] = [];

  /** The main device ID (has authority to modify the list) */
  mainDeviceId?: string;

  /** Schema version */
  version: number = 1;

  /** Event creation timestamp */
  createdAt: number;

  private constructor(owner: string, createdAt?: number) {
    this.owner = owner;
    this.createdAt = createdAt ?? Math.floor(Date.now() / 1000);
  }

  /**
   * Create a new empty invite list for an owner.
   */
  static create(owner: string): InviteList {
    return new InviteList(owner);
  }

  /**
   * Create a new device entry with generated keys.
   */
  static createDevice(label: string): DeviceEntry {
    const keypair = generateEphemeralKeypair();
    return {
      ephemeralPublicKey: keypair.publicKey,
      ephemeralPrivateKey: keypair.privateKey,
      sharedSecret: generateSharedSecret(),
      deviceId: generateDeviceId(),
      label,
    };
  }

  /**
   * Parse an InviteList from a Nostr event.
   */
  static fromEvent(event: VerifiedEvent): InviteList {
    if (!event.sig) {
      throw new Error("Event is not signed");
    }
    if (!verifyEvent(event)) {
      throw new Error("Event signature is invalid");
    }

    const list = new InviteList(event.pubkey, event.created_at);

    for (const tag of event.tags) {
      if (tag[0] === 'device' && tag.length >= 5) {
        const [, ephemeralPublicKey, sharedSecret, deviceId, label] = tag;
        if (ephemeralPublicKey && sharedSecret && deviceId && label) {
          list.devices.set(deviceId, {
            ephemeralPublicKey,
            sharedSecret,
            deviceId,
            label,
          });
        }
      } else if (tag[0] === 'removed' && tag.length >= 3) {
        const [, deviceId, timestamp] = tag;
        if (deviceId && timestamp) {
          list.removed.push({
            deviceId,
            timestamp: Number(timestamp),
          });
        }
      } else if (tag[0] === 'main-device' && tag[1]) {
        list.mainDeviceId = tag[1];
      } else if (tag[0] === 'version' && tag[1]) {
        list.version = Number(tag[1]);
      }
    }

    return list;
  }

  /**
   * Get the unsigned Nostr event for this invite list.
   */
  getEvent(): UnsignedEvent {
    const tags: string[][] = [
      ['d', 'double-ratchet/invite-list'],
    ];

    // Add device tags
    for (const device of this.devices.values()) {
      tags.push([
        'device',
        device.ephemeralPublicKey,
        device.sharedSecret,
        device.deviceId,
        device.label,
      ]);
    }

    // Add removed tags
    for (const removed of this.removed) {
      tags.push(['removed', removed.deviceId, String(removed.timestamp)]);
    }

    // Add main-device tag if set
    if (this.mainDeviceId) {
      tags.push(['main-device', this.mainDeviceId]);
    }

    // Add version tag
    tags.push(['version', String(this.version)]);

    return {
      kind: INVITE_LIST_KIND,
      pubkey: this.owner,
      created_at: this.createdAt,
      tags,
      content: '',
    };
  }

  /**
   * Add a device to the list.
   * If the device ID already exists, it will be replaced.
   * If the device ID is in the removed list, it will NOT be added.
   */
  addDevice(device: DeviceEntry): void {
    // Don't add if it's in the removed list
    if (this.removed.some(r => r.deviceId === device.deviceId)) {
      return;
    }
    this.devices.set(device.deviceId, device);
  }

  /**
   * Remove a device from the list.
   * The device will be moved to the removed list with a timestamp.
   */
  removeDevice(deviceId: string): void {
    if (!this.devices.has(deviceId)) {
      return;
    }
    this.devices.delete(deviceId);
    this.removed.push({
      deviceId,
      timestamp: Math.floor(Date.now() / 1000),
    });
  }

  /**
   * Get a device by ID.
   * Returns undefined if the device doesn't exist or has been removed.
   */
  getDevice(deviceId: string): DeviceEntry | undefined {
    return this.devices.get(deviceId);
  }

  /**
   * Get all active devices (not removed).
   */
  getAllDevices(): DeviceEntry[] {
    return Array.from(this.devices.values());
  }

  /**
   * Merge this list with another list.
   * Used for conflict resolution when multiple updates happen.
   *
   * Rules:
   * - Union all devices
   * - Union all removed entries
   * - Filter out devices that appear in removed
   * - Keep latest device when duplicates exist
   */
  merge(other: InviteList): InviteList {
    const merged = new InviteList(this.owner);
    merged.createdAt = Math.max(this.createdAt, other.createdAt);

    // Union all removed entries, deduplicating by deviceId (keep latest timestamp)
    const removedMap = new Map<string, RemovedEntry>();
    for (const r of [...this.removed, ...other.removed]) {
      const existing = removedMap.get(r.deviceId);
      if (!existing || r.timestamp > existing.timestamp) {
        removedMap.set(r.deviceId, r);
      }
    }
    merged.removed = Array.from(removedMap.values());

    // Union all devices, keeping the one from the newer list on conflict
    const allDevices = new Map<string, { device: DeviceEntry; fromList: InviteList }>();

    for (const device of this.devices.values()) {
      allDevices.set(device.deviceId, { device, fromList: this });
    }

    for (const device of other.devices.values()) {
      const existing = allDevices.get(device.deviceId);
      if (!existing || other.createdAt > existing.fromList.createdAt) {
        allDevices.set(device.deviceId, { device, fromList: other });
      }
    }

    // Add devices that aren't in removed list
    for (const { device } of allDevices.values()) {
      if (!removedMap.has(device.deviceId)) {
        merged.devices.set(device.deviceId, device);
      }
    }

    // Keep mainDeviceId from newer list
    merged.mainDeviceId = this.createdAt >= other.createdAt
      ? this.mainDeviceId
      : other.mainDeviceId;

    merged.version = Math.max(this.version, other.version);

    return merged;
  }

  /**
   * Accept an invite for a specific device in this list.
   * Called by the invitee.
   */
  async accept(params: AcceptParams): Promise<{ session: Session; event: VerifiedEvent }> {
    const { deviceId, inviteePublicKey, inviteePrivateKey, nostrSubscribe, inviteeDeviceId } = params;

    const device = this.getDevice(deviceId);
    if (!device) {
      throw new Error(`Device ${deviceId} not found in invite list`);
    }

    // Create session using shared utils
    const { session, sessionKey } = createSessionFromAccept({
      nostrSubscribe,
      theirEphemeralPublicKey: device.ephemeralPublicKey,
      sharedSecret: device.sharedSecret,
      isInitiator: true,
    });

    // Create encrypted response
    const { event } = await encryptInviteResponse({
      inviteeSessionPublicKey: sessionKey.publicKey,
      inviteePublicKey,
      inviteePrivateKey,
      inviterPublicKey: this.owner,
      inviterEphemeralPublicKey: device.ephemeralPublicKey,
      sharedSecret: device.sharedSecret,
      deviceId: inviteeDeviceId,
    });

    return { session, event };
  }

  /**
   * Listen for invite acceptances on a specific device.
   * Called by the inviter (owner of this list).
   */
  listen(params: ListenParams): Unsubscribe {
    const { deviceId, ownerPrivateKey, nostrSubscribe, onSession } = params;

    const device = this.getDevice(deviceId);
    if (!device) {
      throw new Error(`Device ${deviceId} not found in invite list`);
    }

    if (!device.ephemeralPrivateKey) {
      throw new Error(`Device ${deviceId} does not have a private key (cannot listen)`);
    }

    const filter = {
      kinds: [INVITE_RESPONSE_KIND],
      '#p': [device.ephemeralPublicKey],
    };

    return nostrSubscribe(filter, async (event) => {
      try {
        // Decrypt the response
        const result = await decryptInviteResponse({
          event,
          inviterEphemeralPrivateKey: device.ephemeralPrivateKey!,
          inviterPrivateKey: ownerPrivateKey,
          sharedSecret: device.sharedSecret,
        });

        // Create session
        const { session } = createSessionFromAccept({
          nostrSubscribe,
          theirEphemeralPublicKey: result.sessionKey,
          sharedSecret: device.sharedSecret,
          isInitiator: false,
          ourKeyPair: {
            publicKey: device.ephemeralPublicKey,
            privateKey: device.ephemeralPrivateKey!,
          },
          sessionName: event.id,
        });

        onSession(session, result.inviteePublicKey, result.deviceId);
      } catch {
        // Silently ignore decryption failures
      }
    });
  }
}
