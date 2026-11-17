const $ = id => document.getElementById(id);

export function decodePairingStatus(report) {
  if (report.length < 63 || report[44] !== 0xb1) throw new Error('当前固件不支持网页配对管理，请先更新体感固件');
  return { count: report[45], active: report[46], state: report[47], command: report[48], sequence: report[49], page: report[50], present: !!report[51], address: report.slice(52, 58) };
}

export async function pairingOperation(transport, command, data = []) {
  decodePairingStatus(await transport.read(0xf7));
  const ack = await transport.legacy(0xf6, command, data);
  const sequence = ack[42], until = performance.now() + 6000;
  while (performance.now() < until) {
    const state = decodePairingStatus(await transport.read(0xf7));
    if (state.command === command && state.sequence === sequence && state.state >= 2) {
      if (state.state !== 2) throw new Error('接收器暂时无法执行操作。请先断开手柄，等待蓝牙空闲后重试');
      return state;
    }
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error('配对操作超时，请重新读取状态');
}

export function initPairingUI({ transport, action, message }) {
  const list = $('pairingList');
  if (!list) return;
  const run = (command, data) => pairingOperation(transport(), command, data);
  async function refresh() {
    const first = await run(6, [0]);
    if (first.count > 8) throw new Error('接收器返回的配对数量无效');
    const entries = [];
    for (let i = 0; i < first.count; i++) {
      const item = i ? await run(6, [i]) : first;
      if (!item.present || item.page !== i || item.count !== first.count) throw new Error('配对列表已变化，请重新读取');
      entries.push(item);
    }
    list.replaceChildren();
    if (!entries.length) { list.textContent = '暂无已保存的手柄'; return; }
    for (const item of entries) {
      const row = document.createElement('div'); row.className = 'actions';
      const name = document.createElement('span');
      name.textContent = '手柄 ' + (item.page + 1) + (item.page === item.active ? ' · 当前' : '') + ' · ' + Array.from(item.address).reverse().map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '删除此配对'; remove.className = 'requires-device';
      remove.onclick = () => action(async () => {
        if (!confirm('删除此手柄的配对记录？当前手柄会断开，之后需要重新配对；支持配对同步的管理器会在下次切换固件时同步删除；旧版管理器不会自动同步。')) return;
        await run(8, item.address); await refresh(); message('配对记录已删除');
      });
      row.append(name, remove); list.append(row);
    }
  }
  $('pairingRefresh').onclick = () => action(async () => { await refresh(); message('已读取配对列表'); });
  $('pairingScan').onclick = () => action(async () => { await run(7); message('已开始搜索，请让手柄进入配对模式'); });
}
