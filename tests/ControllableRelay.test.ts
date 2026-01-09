import { describe, it, expect, vi } from 'vitest'
import { ControllableRelay } from './helpers/ControllableRelay'
import { generateSecretKey, getPublicKey } from 'nostr-tools'
import { Session } from '../src/Session'

describe('ControllableRelay', () => {
  it('should store events on publish without delivering', async () => {
    const relay = new ControllableRelay()
    const secretKey = generateSecretKey()
    const pubkey = getPublicKey(secretKey)

    const callback = vi.fn()
    relay.subscribe({ kinds: [1], authors: [pubkey] }, callback)

    await relay.publish({
      kind: 1,
      content: 'hello',
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
      pubkey,
    }, secretKey)

    // Event stored but not delivered
    expect(relay.getEvents()).toHaveLength(1)
    expect(callback).not.toHaveBeenCalled()
  })

  it('should deliver event to matching subscribers', async () => {
    const relay = new ControllableRelay()
    const secretKey = generateSecretKey()
    const pubkey = getPublicKey(secretKey)

    const callback = vi.fn()
    relay.subscribe({ kinds: [1], authors: [pubkey] }, callback)

    const event = await relay.publish({
      kind: 1,
      content: 'hello',
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
      pubkey,
    }, secretKey)

    // Explicitly deliver
    const count = relay.deliver(event.id)

    expect(count).toBe(1)
    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith(event)
  })

  it('should not deliver to non-matching subscribers', async () => {
    const relay = new ControllableRelay()
    const secretKey = generateSecretKey()
    const pubkey = getPublicKey(secretKey)

    const callback = vi.fn()
    relay.subscribe({ kinds: [2] }, callback) // Different kind

    const event = await relay.publish({
      kind: 1,
      content: 'hello',
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
      pubkey,
    }, secretKey)

    relay.deliver(event.id)

    expect(callback).not.toHaveBeenCalled()
  })

  it('should not deliver same event twice', async () => {
    const relay = new ControllableRelay()
    const secretKey = generateSecretKey()
    const pubkey = getPublicKey(secretKey)

    const callback = vi.fn()
    relay.subscribe({ kinds: [1] }, callback)

    const event = await relay.publish({
      kind: 1,
      content: 'hello',
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
      pubkey,
    }, secretKey)

    relay.deliver(event.id)
    relay.deliver(event.id)
    relay.deliver(event.id)

    expect(callback).toHaveBeenCalledTimes(1)
  })

  it('should deliver to specific subscriber with deliverTo', async () => {
    const relay = new ControllableRelay()
    const secretKey = generateSecretKey()
    const pubkey = getPublicKey(secretKey)

    const callback1 = vi.fn()
    const callback2 = vi.fn()

    relay.subscribe({ kinds: [1] }, callback1)
    relay.subscribe({ kinds: [1] }, callback2)

    const event = await relay.publish({
      kind: 1,
      content: 'hello',
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
      pubkey,
    }, secretKey)

    const subs = relay.getSubscribers()
    expect(subs).toHaveLength(2)

    // Deliver to first subscriber only
    relay.deliverTo(event.id, subs[0].id)

    expect(callback1).toHaveBeenCalledTimes(1)
    expect(callback2).not.toHaveBeenCalled()

    // Deliver to all (second subscriber gets it now)
    relay.deliver(event.id)

    expect(callback1).toHaveBeenCalledTimes(1) // Still 1, already delivered
    expect(callback2).toHaveBeenCalledTimes(1)
  })

  it('should deliver all events with deliverAll', async () => {
    const relay = new ControllableRelay()
    const secretKey = generateSecretKey()
    const pubkey = getPublicKey(secretKey)

    const callback = vi.fn()
    relay.subscribe({ kinds: [1] }, callback)

    await relay.publish({ kind: 1, content: '1', tags: [], created_at: 1, pubkey }, secretKey)
    await relay.publish({ kind: 1, content: '2', tags: [], created_at: 2, pubkey }, secretKey)
    await relay.publish({ kind: 1, content: '3', tags: [], created_at: 3, pubkey }, secretKey)

    expect(callback).not.toHaveBeenCalled()

    relay.deliverAll()

    expect(callback).toHaveBeenCalledTimes(3)
  })

  it('should deliver by kind', async () => {
    const relay = new ControllableRelay()
    const secretKey = generateSecretKey()
    const pubkey = getPublicKey(secretKey)

    const callback = vi.fn()
    relay.subscribe({ kinds: [1, 2] }, callback)

    await relay.publish({ kind: 1, content: 'kind1', tags: [], created_at: 1, pubkey }, secretKey)
    await relay.publish({ kind: 2, content: 'kind2', tags: [], created_at: 2, pubkey }, secretKey)

    relay.deliverByKind(1)

    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback.mock.calls[0][0].content).toBe('kind1')

    relay.deliverByKind(2)

    expect(callback).toHaveBeenCalledTimes(2)
    expect(callback.mock.calls[1][0].content).toBe('kind2')
  })

  it('should track undelivered events', async () => {
    const relay = new ControllableRelay()
    const secretKey = generateSecretKey()
    const pubkey = getPublicKey(secretKey)

    relay.subscribe({ kinds: [1] }, vi.fn())

    const event1 = await relay.publish({ kind: 1, content: '1', tags: [], created_at: 1, pubkey }, secretKey)
    const event2 = await relay.publish({ kind: 1, content: '2', tags: [], created_at: 2, pubkey }, secretKey)

    expect(relay.getUndelivered()).toHaveLength(2)

    relay.deliver(event1.id)

    expect(relay.getUndelivered()).toHaveLength(1)
    expect(relay.getUndelivered()[0].id).toBe(event2.id)

    relay.deliver(event2.id)

    expect(relay.getUndelivered()).toHaveLength(0)
  })

  it('should handle replaceable events', async () => {
    const relay = new ControllableRelay()
    const secretKey = generateSecretKey()
    const pubkey = getPublicKey(secretKey)

    // Kind 10078 is replaceable (10000-19999 range)
    await relay.publish({
      kind: 10078,
      content: 'first',
      tags: [['d', 'test']],
      created_at: 1,
      pubkey,
    }, secretKey)

    await relay.publish({
      kind: 10078,
      content: 'second',
      tags: [['d', 'test']],
      created_at: 2,
      pubkey,
    }, secretKey)

    // Only latest should be stored
    const events = relay.getEvents()
    expect(events).toHaveLength(1)
    expect(events[0].content).toBe('second')
  })

  it('should clear all state', async () => {
    const relay = new ControllableRelay()
    const secretKey = generateSecretKey()
    const pubkey = getPublicKey(secretKey)

    relay.subscribe({ kinds: [1] }, vi.fn())
    await relay.publish({ kind: 1, content: 'test', tags: [], created_at: 1, pubkey }, secretKey)

    expect(relay.getEvents()).toHaveLength(1)
    expect(relay.getSubscribers()).toHaveLength(1)

    relay.clear()

    expect(relay.getEvents()).toHaveLength(0)
    expect(relay.getSubscribers()).toHaveLength(0)
  })

  it('should work with Session for out-of-order delivery', async () => {
    const relay = new ControllableRelay()

    const aliceSecretKey = generateSecretKey()
    const bobSecretKey = generateSecretKey()
    const sharedSecret = new Uint8Array(32)

    const alice = Session.init(
      relay.subscribe.bind(relay),
      getPublicKey(bobSecretKey),
      aliceSecretKey,
      true,
      sharedSecret,
      'alice'
    )

    const bob = Session.init(
      relay.subscribe.bind(relay),
      getPublicKey(aliceSecretKey),
      bobSecretKey,
      false,
      sharedSecret,
      'bob'
    )

    const bobReceived: string[] = []
    bob.onEvent((event) => {
      bobReceived.push(event.content)
    })

    // Alice sends 3 messages
    const { event: msg1 } = alice.send('first')
    const { event: msg2 } = alice.send('second')
    const { event: msg3 } = alice.send('third')

    await relay.publish(msg1)
    await relay.publish(msg2)
    await relay.publish(msg3)

    // Deliver out of order
    relay.deliver(msg3.id)
    relay.deliver(msg1.id)
    relay.deliver(msg2.id)

    // Bob receives in delivery order (double ratchet handles decryption)
    expect(bobReceived).toEqual(['third', 'first', 'second'])
  })

  it('should handle subscriptions created after publish', async () => {
    const relay = new ControllableRelay()
    const secretKey = generateSecretKey()
    const pubkey = getPublicKey(secretKey)

    // Publish first
    const event = await relay.publish({
      kind: 1,
      content: 'hello',
      tags: [],
      created_at: 1,
      pubkey,
    }, secretKey)

    // Subscribe after
    const callback = vi.fn()
    relay.subscribe({ kinds: [1] }, callback)

    // Event not auto-delivered
    expect(callback).not.toHaveBeenCalled()

    // Explicit deliver works
    relay.deliver(event.id)
    expect(callback).toHaveBeenCalledTimes(1)
  })

  it('should unsubscribe correctly', async () => {
    const relay = new ControllableRelay()
    const secretKey = generateSecretKey()
    const pubkey = getPublicKey(secretKey)

    const callback = vi.fn()
    const unsub = relay.subscribe({ kinds: [1] }, callback)

    const event = await relay.publish({
      kind: 1,
      content: 'hello',
      tags: [],
      created_at: 1,
      pubkey,
    }, secretKey)

    unsub()

    relay.deliver(event.id)

    expect(callback).not.toHaveBeenCalled()
    expect(relay.getSubscribers()).toHaveLength(0)
  })
})
