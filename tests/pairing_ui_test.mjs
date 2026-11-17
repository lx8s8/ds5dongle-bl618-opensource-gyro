import assert from 'node:assert/strict';
import { decodePairingStatus, pairingOperation } from '../web/pairing-ui.mjs';

const report = new Uint8Array(63);
report[44] = 0xb1; report[45] = 1; report[46] = 0;
assert.equal(decodePairingStatus(report).count, 1);
assert.throws(() => decodePairingStatus(new Uint8Array(63)), /不支持/);
let sent = 0;
const fake = {
  async read() { return report.slice(); },
  async legacy(id, command, data) {
    assert.equal(id, 0xf6); assert.deepEqual(data, [0]); sent++;
    report[47] = 2; report[48] = command; report[49] = 7;
    report[50] = 0; report[51] = 1; report.set([1, 2, 3, 4, 5, 6], 52);
    const ack = report.slice(); ack[42] = 7; return ack;
  },
};
const state = await pairingOperation(fake, 6, [0]);
assert.equal(state.present, true); assert.deepEqual([...state.address], [1, 2, 3, 4, 5, 6]);
assert.equal(sent, 1);
await assert.rejects(pairingOperation({ read: async () => new Uint8Array(63), legacy: async () => { throw new Error('must not write'); } }, 8, [1, 2, 3, 4, 5, 6]), /不支持/);
console.log('pairing UI: capability guard, request and paired-address decoding passed');
