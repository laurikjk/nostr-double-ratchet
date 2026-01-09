import { matchFilter, VerifiedEvent, UnsignedEvent, Filter } from "nostr-tools"
import { NDKEvent, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk"

export interface SubscriberInfo {
  id: string
  filter: Filter
  delivered: Set<string>
}

interface Subscriber extends SubscriberInfo {
  onEvent: (e: VerifiedEvent) => void
}

export class ControllableRelay {
  private events: Map<string, VerifiedEvent> = new Map()
  private subscribers: Map<string, Subscriber> = new Map()
  private subscriptionCounter = 0
  private debug: boolean

  constructor(options: { debug?: boolean } = {}) {
    this.debug = options.debug ?? false
  }

  // PUBLISH - stores event, does NOT deliver
  // Can accept either UnsignedEvent (will sign) or VerifiedEvent (already signed)
  async publish(
    event: UnsignedEvent | VerifiedEvent,
    signerSecretKey?: Uint8Array
  ): Promise<VerifiedEvent> {
    let verifiedEvent: VerifiedEvent

    // Check if already signed (has id and sig)
    if ('id' in event && 'sig' in event && event.id && event.sig) {
      verifiedEvent = event as VerifiedEvent
    } else {
      // Need to sign
      const ndkEvent = new NDKEvent()
      ndkEvent.kind = event.kind
      ndkEvent.content = event.content
      ndkEvent.tags = event.tags || []
      ndkEvent.created_at = event.created_at
      ndkEvent.pubkey = event.pubkey

      if (signerSecretKey) {
        const signer = new NDKPrivateKeySigner(signerSecretKey)
        await ndkEvent.sign(signer)
      }

      verifiedEvent = {
        ...event,
        id: ndkEvent.id!,
        sig: ndkEvent.sig!,
        tags: ndkEvent.tags || [],
      } as VerifiedEvent
    }

    // Handle replaceable events (kinds 10000-19999): replace older with same pubkey + d-tag
    if (event.kind >= 10000 && event.kind < 20000) {
      const dTag = event.tags?.find((t) => t[0] === "d")?.[1]
      for (const [id, e] of this.events) {
        if (e.kind !== event.kind || e.pubkey !== event.pubkey) continue
        const existingDTag = e.tags?.find((t) => t[0] === "d")?.[1]
        if (existingDTag === dTag) {
          this.events.delete(id)
          break
        }
      }
    }

    this.events.set(verifiedEvent.id, verifiedEvent)

    if (this.debug) {
      console.log(`[ControllableRelay] Published event ${verifiedEvent.id.slice(0, 8)} (kind ${event.kind})`)
    }

    return verifiedEvent
  }

  // SUBSCRIBE - registers listener, does NOT deliver stored events
  subscribe(filter: Filter, onEvent: (event: VerifiedEvent) => void): () => void {
    this.subscriptionCounter++
    const subId = `sub-${this.subscriptionCounter}`

    const subscriber: Subscriber = {
      id: subId,
      filter,
      onEvent,
      delivered: new Set(),
    }

    this.subscribers.set(subId, subscriber)

    if (this.debug) {
      console.log(`[ControllableRelay] New subscription ${subId}`, filter)
    }

    return () => {
      this.subscribers.delete(subId)
      if (this.debug) {
        console.log(`[ControllableRelay] Unsubscribed ${subId}`)
      }
    }
  }

  // DELIVERY CONTROL

  // Deliver a specific event to all matching subscribers
  deliver(eventId: string): number {
    const event = this.events.get(eventId)
    if (!event) {
      if (this.debug) {
        console.log(`[ControllableRelay] deliver: event ${eventId} not found`)
      }
      return 0
    }

    let count = 0
    for (const sub of this.subscribers.values()) {
      if (this.deliverEventToSubscriber(event, sub)) {
        count++
      }
    }

    if (this.debug) {
      console.log(`[ControllableRelay] Delivered ${eventId.slice(0, 8)} to ${count} subscribers`)
    }

    return count
  }

  // Deliver a specific event to a specific subscriber
  deliverTo(eventId: string, subId: string): boolean {
    const event = this.events.get(eventId)
    const subscriber = this.subscribers.get(subId)

    if (!event || !subscriber) {
      if (this.debug) {
        console.log(`[ControllableRelay] deliverTo: event or subscriber not found`)
      }
      return false
    }

    return this.deliverEventToSubscriber(event, subscriber)
  }

  // Deliver all events to all matching subscribers
  deliverAll(): number {
    let count = 0
    for (const event of this.events.values()) {
      for (const sub of this.subscribers.values()) {
        if (this.deliverEventToSubscriber(event, sub)) {
          count++
        }
      }
    }

    if (this.debug) {
      console.log(`[ControllableRelay] deliverAll: ${count} deliveries`)
    }

    return count
  }

  // Deliver all events of a specific kind
  deliverByKind(kind: number): number {
    let count = 0
    for (const event of this.events.values()) {
      if (event.kind === kind) {
        for (const sub of this.subscribers.values()) {
          if (this.deliverEventToSubscriber(event, sub)) {
            count++
          }
        }
      }
    }

    if (this.debug) {
      console.log(`[ControllableRelay] deliverByKind(${kind}): ${count} deliveries`)
    }

    return count
  }

  // Deliver all events from a specific pubkey
  deliverByPubkey(pubkey: string): number {
    let count = 0
    for (const event of this.events.values()) {
      if (event.pubkey === pubkey) {
        for (const sub of this.subscribers.values()) {
          if (this.deliverEventToSubscriber(event, sub)) {
            count++
          }
        }
      }
    }

    if (this.debug) {
      console.log(`[ControllableRelay] deliverByPubkey(${pubkey.slice(0, 8)}): ${count} deliveries`)
    }

    return count
  }

  // INSPECTION

  getEvents(): VerifiedEvent[] {
    return Array.from(this.events.values())
  }

  getEvent(id: string): VerifiedEvent | undefined {
    return this.events.get(id)
  }

  getSubscribers(): SubscriberInfo[] {
    return Array.from(this.subscribers.values()).map(({ id, filter, delivered }) => ({
      id,
      filter,
      delivered: new Set(delivered),
    }))
  }

  // Get events not yet delivered (optionally to a specific subscriber)
  getUndelivered(subId?: string): VerifiedEvent[] {
    if (subId) {
      const subscriber = this.subscribers.get(subId)
      if (!subscriber) return []

      return Array.from(this.events.values()).filter(
        (event) => !subscriber.delivered.has(event.id) && matchFilter(subscriber.filter, event)
      )
    }

    // Events not delivered to ANY subscriber
    return Array.from(this.events.values()).filter((event) => {
      for (const sub of this.subscribers.values()) {
        if (sub.delivered.has(event.id)) {
          return false
        }
      }
      return true
    })
  }

  // RESET

  clear(): void {
    this.events.clear()
    this.subscribers.clear()
    this.subscriptionCounter = 0

    if (this.debug) {
      console.log(`[ControllableRelay] Cleared`)
    }
  }

  // PRIVATE

  private deliverEventToSubscriber(event: VerifiedEvent, subscriber: Subscriber): boolean {
    // Already delivered
    if (subscriber.delivered.has(event.id)) {
      return false
    }

    // Doesn't match filter
    if (!matchFilter(subscriber.filter, event)) {
      return false
    }

    subscriber.delivered.add(event.id)

    if (this.debug) {
      console.log(`[ControllableRelay] Delivering ${event.id.slice(0, 8)} to ${subscriber.id}`)
    }

    try {
      subscriber.onEvent(event)
    } catch (error) {
      // Swallow decryption errors like MockRelay does
      if (this.isDecryptionError(error)) {
        if (this.debug) {
          console.log(`[ControllableRelay] Ignored decrypt error for ${event.id.slice(0, 8)}`)
        }
        return true
      }
      throw error
    }

    return true
  }

  private isDecryptionError(error: unknown): boolean {
    if (!(error instanceof Error)) return false
    const message = error.message?.toLowerCase()
    if (!message) return false
    return message.includes("invalid mac") || message.includes("failed to decrypt header")
  }
}
