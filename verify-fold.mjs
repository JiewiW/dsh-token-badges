/**
 * 验证 dsh-token-badges 的 user-token 徽章是否按预期参与 ui-chat 工作流折叠。
 *
 * 做法：读一份真实会话日志（JSONL），复刻插件 client.js 的 match/buildViewNode
 * 决策与 ui-chat 的 processMember 判据，输出每枚徽章的归属结论。
 *
 * 用法：node verify-fold.mjs <session.jsonl>
 */

import { readFileSync } from "node:fs";

/** ui-chat 写死的折叠白名单（非白名单 kind 都会被吸进过程块）。 */
const TURN_PROCESS_INDEPENDENT_KINDS = new Set([
  "system-prompt",
  "user",
  "steering",
  "turn-trigger",
  "turn-process",
  "turn-error",
  "turn-max-tokens",
  "turn-tail",
]);

const USER_TOKEN_OFFSET = 0.15;
const UNRESOLVED = { kind: "unresolved" };

/** 复刻插件 isHumanPrompt。 */
function isHumanPrompt(event) {
  const source = event.data && event.data.source;
  return (
    event.type === "user/message" &&
    event.surfaceOp === "append" &&
    source !== undefined &&
    source.kind === "user"
  );
}

/** 复刻插件 eventLocation：优先 start.location，其次 matches[0].location。 */
function eventLocation(startLocation) {
  return startLocation === undefined ? UNRESOLVED : startLocation;
}

/**
 * 复刻插件 buildViewNode 的 location/anchorSeq 决策。
 *
 * 真实的 ui-chat location 形如 { kind:'step', turn:<Turn>, step:<Step> }，
 * 其中 turn 是带 turn 字段的对象、step 是带 step 字段的对象；这里用同样
 * 形状的替身，避免形状不一致导致判据恒假。
 */
function buildBadge(event, startLocation) {
  const human = isHumanPrompt(event);
  return {
    seq: event.seq,
    human,
    sourceKind: event.data?.source?.kind ?? "(none)",
    anchorSeq: event.seq + USER_TOKEN_OFFSET,
    location: human ? UNRESOLVED : eventLocation(startLocation),
  };
}

function readEvents(file) {
  const events = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      /* torn tail line: skip */
    }
  }
  return events;
}

const file = process.argv[2];
if (file === undefined) {
  console.error("用法: node verify-fold.mjs <session.jsonl>");
  process.exit(2);
}

const events = readEvents(file);

// 每个 turn 的起点：turn/start 的 seq，即 ui-chat 的 processStartSeq。
const turnStartSeq = new Map();
for (const event of events) {
  if (event.type === "turn/start") turnStartSeq.set(event.data.turn, event.seq);
}

// 会话日志的 location 由事件引擎按所在 turn/step 给出；这里按 step/start
// ~ step/end 区间重建同样的归属（日志行本身不带 location 字段）。
const stepRanges = [];
for (const event of events) {
  if (event.type === "step/start") {
    stepRanges.push({ turn: event.data.turn, step: event.data.step, start: event.seq, end: Infinity });
  } else if (event.type === "step/end") {
    for (let i = stepRanges.length - 1; i >= 0; i--) {
      if (stepRanges[i].turn === event.data.turn && stepRanges[i].step === event.data.step) {
        stepRanges[i].end = event.seq;
        break;
      }
    }
  }
}

function locationOf(seq) {
  const range = stepRanges.find((item) => seq >= item.start && seq <= item.end);
  if (range === undefined) return undefined;
  // 与 ui-chat 同形：turn 是带 turn 字段的对象，step 是带 step 字段的对象。
  return {
    kind: "step",
    turn: { turn: range.turn, steps: [], data: new Map(), status: "open" },
    step: { step: range.step, status: "open", data: new Map() },
  };
}

const badges = [];
for (const event of events) {
  if (event.type !== "user/message") continue;
  badges.push(buildBadge(event, locationOf(event.seq)));
}

let folded = 0;
let stayVisible = 0;
const rows = [];
for (const badge of badges) {
  const coords =
    badge.location.kind === "turn" || badge.location.kind === "step" ? badge.location.turn.turn : undefined;
  const processStartSeq = coords === undefined ? undefined : turnStartSeq.get(coords);
  // ui-chat: processMember = 有 process 窗口 && kind 不在白名单 &&
  // anchorSeq >= processStartSeq && (…anchorSeq < answerAnchorSeq)
  const isProcessMember =
    processStartSeq !== undefined &&
    !TURN_PROCESS_INDEPENDENT_KINDS.has("user-token") &&
    badge.anchorSeq >= processStartSeq;
  if (isProcessMember) folded += 1;
  else stayVisible += 1;
  rows.push({
    seq: badge.seq,
    src: badge.sourceKind,
    human: badge.human,
    location: badge.location.kind === "step" ? `step t${coords}.${badge.location.step.step}` : badge.location.kind,
    processMember: isProcessMember,
  });
}

console.log(`会话: ${file}`);
console.log(`user/message 徽章总数: ${badges.length}`);
console.log(`  会随折叠收起: ${folded}`);
console.log(`  常驻可见:     ${stayVisible}`);
console.log("");
console.log("seq\tsource\t\t\t\thuman\tlocation\t折叠?");
for (const row of rows.slice(0, 40)) {
  console.log(
    `${row.seq}\t${row.src.padEnd(24, " ").slice(0, 24)}\t${row.human}\t${String(row.location).padEnd(8, " ")}\t${
      row.processMember ? "是" : "否"
    }`,
  );
}
if (rows.length > 40) console.log(`… 其余 ${rows.length - 40} 条省略`);
