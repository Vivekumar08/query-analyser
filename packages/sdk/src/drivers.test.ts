import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { Aggregator } from './aggregator.js';
import { setSink, type MonitorSink } from './monitor.js';
import {
  CONNECT_WRAP,
  MONITORING_OFF_WARNING,
  enableMonitoring,
  installConnectWrap,
  monitorState,
  mongooseClients,
  resolvePeer,
  undoConnectWraps,
} from './drivers.js';

const fakeSink = (over: Partial<MonitorSink> = {}): MonitorSink => ({ aggregator: new Aggregator(100), thresholdMs: 100,
  onError: vi.fn(), isDisabled: () => false, captureRawSample: () => false, resolveModel: (_d, coll) => coll, ...over });

function makeFake4() {
  class Fake4 extends EventEmitter {
    options = { monitorCommands: false };
    result = Promise.resolve(this);
    seenAtConnect?: boolean;
    get monitorCommands() { return this.options.monitorCommands; }
    set monitorCommands(v: boolean) { this.options.monitorCommands = v; }
    connect(cb?: (e?: Error) => void) {
      this.seenAtConnect = this.options.monitorCommands;
      if (cb) { cb(); return undefined; }
      return this.result;
    }
  }
  return Fake4;
}
function makeFake3() {
  class Fake3 extends EventEmitter { connect() { return Promise.resolve(this); } }
  return Fake3;
}
const hasOwn = (o: object, k: PropertyKey) => Object.prototype.hasOwnProperty.call(o, k);

beforeEach(() => setSink(fakeSink()));
afterEach(() => { undoConnectWraps(); setSink(null); vi.restoreAllMocks(); });

describe('constants', () => {
  it('CONNECT_WRAP is the shared registry symbol and the warning is verbatim', () => {
    expect(CONNECT_WRAP).toBe(Symbol.for('query-analyser.connect-wrap'));
    expect(MONITORING_OFF_WARNING).toBe(
      'query-analyser: command monitoring is off for a MongoClient, so if this client was already connected its queries are not captured. Pass `monitorCommands: true` in its connect options, or call init() before connecting.',
    );
  });
});

describe('installConnectWrap', () => {
  it('sets monitorCommands and attaches before the original connect runs, and returns its value', () => {
    const Fake4 = makeFake4();
    expect(installConnectWrap(Fake4)).toBe(true);
    const c = new Fake4();
    expect(c.connect()).toBe(c.result);
    expect(c.seenAtConnect).toBe(true);
    expect(c.listenerCount('commandStarted')).toBe(1);
    expect(Fake4.prototype.connect.name).toBe('connect');
  });

  it('passes a callback through untouched', () => {
    const Fake4 = makeFake4();
    installConnectWrap(Fake4);
    const c = new Fake4();
    const cb = vi.fn();
    expect(c.connect(cb)).toBeUndefined();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith();
    expect(c.seenAtConnect).toBe(true);
  });

  it('passes every argument through to the original', () => {
    class Spy extends EventEmitter { connect(...args: unknown[]) { return args; } }
    installConnectWrap(Spy);
    const a = { x: 1 }; const b = () => {};
    const out = (new Spy().connect as (...x: unknown[]) => unknown[])(a, b, 3);
    expect(out).toEqual([a, b, 3]);
    expect(out[0]).toBe(a);
    expect(out[1]).toBe(b);
  });

  it('is idempotent: wrapping twice wraps once', () => {
    const Fake4 = makeFake4();
    expect(installConnectWrap(Fake4)).toBe(true);
    const first = Fake4.prototype.connect;
    expect(installConnectWrap(Fake4)).toBe(false);
    expect(Fake4.prototype.connect).toBe(first);
    const c = new Fake4();
    const enable = vi.spyOn(Fake4.prototype, 'monitorCommands', 'set');
    c.connect();
    expect(enable).toHaveBeenCalledTimes(1);
  });

  it('does not wrap a subclass that inherits an already wrapped connect', () => {
    const Fake4 = makeFake4();
    class Sub extends Fake4 {}
    installConnectWrap(Fake4);
    expect(installConnectWrap(Sub)).toBe(false);
    expect(hasOwn(Sub.prototype, 'connect')).toBe(false);
  });

  it('never throws into connect when preparing fails', () => {
    const onError = vi.fn();
    setSink(fakeSink({ onError }));
    class Bad extends EventEmitter {
      options = { monitorCommands: false };
      result = Promise.resolve(this);
      get monitorCommands() { return false; }
      set monitorCommands(_v: boolean) { throw new Error('setter-boom'); }
      connect() { return this.result; }
    }
    installConnectWrap(Bad);
    const c = new Bad();
    expect(c.connect()).toBe(c.result);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'setter-boom' }));
  });

  it('never throws into connect even when onError throws too', () => {
    setSink(fakeSink({ onError: () => { throw new Error('onError-boom'); } }));
    class Bad extends EventEmitter {
      get monitorCommands() { return false; }
      set monitorCommands(_v: boolean) { throw new Error('setter-boom'); }
      connect() { return 'ok'; }
    }
    installConnectWrap(Bad);
    expect(new Bad().connect()).toBe('ok');
  });

  it('propagates what the original connect throws, unchanged', () => {
    const boom = new Error('connect-boom');
    class Thrower extends EventEmitter { connect() { throw boom; } }
    installConnectWrap(Thrower);
    expect(() => new Thrower().connect()).toThrow(boom);
  });

  it('is a pass-through when no analyser is active', () => {
    const Fake4 = makeFake4();
    installConnectWrap(Fake4);
    setSink(null);
    const c = new Fake4();
    expect(c.connect()).toBe(c.result);
    expect(c.seenAtConnect).toBe(false);
    expect(c.listenerCount('commandStarted')).toBe(0);
  });

  it('wraps a driver 3-like client (no setter): attaches, leaves monitorCommands alone', async () => {
    const Fake3 = makeFake3();
    installConnectWrap(Fake3);
    const c = new Fake3();
    await expect(c.connect()).resolves.toBe(c);
    expect(c.listenerCount('commandStarted')).toBe(1);
    expect(hasOwn(c, 'monitorCommands')).toBe(false);
  });

  it('never throws for inputs that are not a MongoClient class', () => {
    expect(installConnectWrap(undefined)).toBe(false);
    expect(installConnectWrap(null)).toBe(false);
    expect(installConnectWrap({})).toBe(false);
    expect(installConnectWrap(class NoConnect {})).toBe(false);
    const frozen = makeFake4();
    Object.freeze(frozen.prototype);
    expect(installConnectWrap(frozen)).toBe(false);
  });
});

describe('undoConnectWraps', () => {
  it('undo restores the original when the wrapper is still on top', () => {
    const Fake4 = makeFake4();
    const original = Fake4.prototype.connect;
    const before = Object.getOwnPropertyDescriptor(Fake4.prototype, 'connect');
    installConnectWrap(Fake4);
    expect(Fake4.prototype.connect).not.toBe(original);
    undoConnectWraps();
    expect(Fake4.prototype.connect).toBe(original);
    expect(Object.getOwnPropertyDescriptor(Fake4.prototype, 'connect')).toEqual(before);
    expect(CONNECT_WRAP in Fake4.prototype).toBe(false);
  });

  it('undo deletes the own property when connect was inherited', () => {
    const Fake4 = makeFake4();
    class Sub extends Fake4 {}
    expect(installConnectWrap(Sub)).toBe(true);
    expect(hasOwn(Sub.prototype, 'connect')).toBe(true);
    const c = new Sub();
    c.connect();
    expect(c.seenAtConnect).toBe(true);
    undoConnectWraps();
    expect(hasOwn(Sub.prototype, 'connect')).toBe(false);
    expect(Sub.prototype.connect).toBe(Fake4.prototype.connect);
    expect(CONNECT_WRAP in Sub.prototype).toBe(false);
  });

  it('can wrap again after an undo', () => {
    const Fake4 = makeFake4();
    installConnectWrap(Fake4);
    undoConnectWraps();
    expect(installConnectWrap(Fake4)).toBe(true);
    const c = new Fake4();
    c.connect();
    expect(c.seenAtConnect).toBe(true);
  });
});

describe('another library also patches connect (Review Focus 3)', () => {
  it('leaves a library wrapper added on top in place and becomes a pass-through', () => {
    const Fake4 = makeFake4();
    installConnectWrap(Fake4);
    const ours = Fake4.prototype.connect;
    const apm = vi.fn(function (this: InstanceType<typeof Fake4>, ...a: unknown[]) { return ours.apply(this, a as []); });
    Fake4.prototype.connect = apm as never;
    undoConnectWraps();
    expect(Fake4.prototype.connect).toBe(apm);
    const c = new Fake4();
    expect(c.connect()).toBe(c.result);
    expect(apm).toHaveBeenCalled();
    expect(c.listenerCount('commandStarted')).toBe(0);
    expect(c.seenAtConnect).toBe(false);
  });

  it('re-activates the buried wrapper on a second install instead of stacking another', () => {
    const Fake4 = makeFake4();
    installConnectWrap(Fake4);
    const ours = Fake4.prototype.connect;
    const apm = vi.fn(function (this: InstanceType<typeof Fake4>, ...a: unknown[]) { return ours.apply(this, a as []); });
    Fake4.prototype.connect = apm as never;
    undoConnectWraps();
    expect(installConnectWrap(Fake4)).toBe(false);
    expect(Fake4.prototype.connect).toBe(apm);
    const c = new Fake4();
    expect(c.connect()).toBe(c.result);
    expect(apm).toHaveBeenCalledTimes(1);
    expect(c.seenAtConnect).toBe(true);
    expect(c.listenerCount('commandStarted')).toBe(1);
    // A second install while active, with the library still on top: still no stacking.
    expect(installConnectWrap(Fake4)).toBe(false);
    expect(Fake4.prototype.connect).toBe(apm);
  });

  it('wraps over a library wrapper installed first and keeps calling it', () => {
    const Fake4 = makeFake4();
    const original = Fake4.prototype.connect;
    const apm = vi.fn(function (this: InstanceType<typeof Fake4>, ...a: unknown[]) { return original.apply(this, a as []); });
    Fake4.prototype.connect = apm as never;
    expect(installConnectWrap(Fake4)).toBe(true);
    expect(installConnectWrap(Fake4)).toBe(false);
    const c = new Fake4();
    expect(c.connect()).toBe(c.result);
    expect(apm).toHaveBeenCalledTimes(1);
    expect(c.seenAtConnect).toBe(true);
    expect(c.listenerCount('commandStarted')).toBe(1);
    const cb = vi.fn();
    expect(new Fake4().connect(cb)).toBeUndefined();
    expect(cb).toHaveBeenCalledTimes(1);
    undoConnectWraps();
    expect(Fake4.prototype.connect).toBe(apm);
  });
});

describe('monitorState / enableMonitoring', () => {
  it('monitorState reads on/off before the setter is touched, and unknown on driver 3', () => {
    const Fake4 = makeFake4();
    const Fake3 = makeFake3();
    expect(monitorState(Object.assign(new Fake4(), { options: { monitorCommands: true } }))).toBe('on');
    expect(monitorState(new Fake4())).toBe('off');
    expect(monitorState(new Fake3())).toBe('unknown');
  });

  it('monitorState never throws', () => {
    const evil = { get options(): unknown { throw new Error('x'); } };
    expect(monitorState(evil)).toBe('unknown');
    expect(monitorState(null as unknown as object)).toBe('unknown');
  });

  it('enableMonitoring sets the 4+ setter and leaves driver 3 alone', () => {
    const Fake4 = makeFake4();
    const Fake3 = makeFake3();
    const c4 = new Fake4();
    enableMonitoring(c4);
    expect(c4.monitorCommands).toBe(true);
    expect(c4.options.monitorCommands).toBe(true);
    const c3 = new Fake3();
    enableMonitoring(c3);
    expect(hasOwn(c3, 'monitorCommands')).toBe(false);
    expect('monitorCommands' in c3).toBe(false);
  });

  it('enableMonitoring never throws', () => {
    class Bad { set monitorCommands(_v: boolean) { throw new Error('boom'); } }
    expect(() => enableMonitoring(new Bad())).not.toThrow();
    expect(() => enableMonitoring(null as unknown as object)).not.toThrow();
  });
});

describe('resolvePeer', () => {
  it('resolvePeer finds the SDK devDependencies and returns null for a missing package', () => {
    expect((resolvePeer('mongoose') as { version: string }).version).toMatch(/^8\./);
    expect(resolvePeer('qa-not-installed-pkg')).toBeNull();
  });
});

describe('mongooseClients', () => {
  it('mongooseClients collects every connection client, skipping missing ones and throwing getters', () => {
    const client = {};
    const mongoose = {
      connections: [
        { getClient: () => client },
        { getClient: () => undefined },
        { getClient: () => { throw new Error('no client'); } },
      ],
    };
    expect(mongooseClients(mongoose)).toEqual([client]);
    expect(mongooseClients(mongoose)[0]).toBe(client);
  });

  it('falls back to conn.client and deduplicates shared clients', () => {
    const a = {}; const b = {};
    const mongoose = { connections: [{ client: a }, { getClient: () => a }, { getClient: () => null, client: b }, null] };
    const out = mongooseClients(mongoose);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(a);
    expect(out[1]).toBe(b);
  });

  it('returns [] for a mongoose without connections', () => {
    expect(mongooseClients({})).toEqual([]);
    const evil = { get connections(): unknown { throw new Error('x'); } };
    expect(mongooseClients(evil)).toEqual([]);
  });
});
