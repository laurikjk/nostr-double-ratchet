import { describe, it, expect } from 'vitest'
import { Session } from '../src/Session'
import { getPublicKey, generateSecretKey } from 'nostr-tools'
import { serializeSessionState, deserializeSessionState } from '../src/utils'

const dummySubscribe = () => () => {}

describe('Offline Session decryption', () => {
  it('decrypts a single event without subscriptions', () => {
    const aliceKey = generateSecretKey()
    const bobKey = generateSecretKey()

    const alice = Session.init(dummySubscribe, getPublicKey(bobKey), aliceKey, true, new Uint8Array())
    const bob = Session.init(dummySubscribe, getPublicKey(aliceKey), bobKey, false, new Uint8Array())

    const event = alice.send('hello bob').event

    const bobState = deserializeSessionState(serializeSessionState(bob.state))
    const inner = Session.decryptEventWithState(bobState, event)

    expect(inner?.content).toBe('hello bob')
  })

  it('handles back and forth messages offline', () => {
    const aliceKey = generateSecretKey()
    const bobKey = generateSecretKey()

    const alice = Session.init(dummySubscribe, getPublicKey(bobKey), aliceKey, true, new Uint8Array())
    const bob = Session.init(dummySubscribe, getPublicKey(aliceKey), bobKey, false, new Uint8Array())

    const offlineAlice = new Session(dummySubscribe, deserializeSessionState(serializeSessionState(alice.state)))
    const offlineBob = new Session(dummySubscribe, deserializeSessionState(serializeSessionState(bob.state)))

    const e1 = offlineAlice.send('hi bob').event
    const m1 = offlineBob.decryptEvent(e1)
    expect(m1?.content).toBe('hi bob')

    const e2 = offlineBob.send('hi alice').event
    const m2 = offlineAlice.decryptEvent(e2)
    expect(m2?.content).toBe('hi alice')
  })

  it('handles out of order events offline', () => {
    const aliceKey = generateSecretKey()
    const bobKey = generateSecretKey()

    const alice = Session.init(dummySubscribe, getPublicKey(bobKey), aliceKey, true, new Uint8Array())
    const bob = Session.init(dummySubscribe, getPublicKey(aliceKey), bobKey, false, new Uint8Array())

    const offlineAlice = new Session(dummySubscribe, deserializeSessionState(serializeSessionState(alice.state)))
    const offlineBob = new Session(dummySubscribe, deserializeSessionState(serializeSessionState(bob.state)))

    const msg1 = offlineAlice.send('one').event
    const msg2 = offlineAlice.send('two').event
    const msg3 = offlineAlice.send('three').event

    const r3 = offlineBob.decryptEvent(msg3)
    expect(r3?.content).toBe('three')
    const r1 = offlineBob.decryptEvent(msg1)
    expect(r1?.content).toBe('one')
    const r2 = offlineBob.decryptEvent(msg2)
    expect(r2?.content).toBe('two')
  })
})
