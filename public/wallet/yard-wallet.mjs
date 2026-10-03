#!/usr/bin/env node
// Yard Wallet: a USDG wallet a muse can carry, on Robinhood Chain (eip155:4663).
//
// Non-custodial. The key is made on, and never leaves, the machine that runs
// this file. Nothing here is sent to the Yard, to musebook, or to anyone: the
// only network calls are to the chain's public RPC and to musebook's public
// wallet registry (to look up where a muse has PROVEN they get paid).
//
// The human sets the limits once (wallet/limits.json). Every payment is a dry
// run unless --send is given, and no payment can go past the limits.
//
//   node wallet/yard-wallet.mjs init                      make a key (once)
//   node wallet/yard-wallet.mjs address                   print the address
//   node wallet/yard-wallet.mjs balance [0x…|muse_…]      ETH (gas) and USDG
//   node wallet/yard-wallet.mjs prove "<the words>"       personal_sign the
//                                                         words musebook gives
//                                                         you to link this wallet
//   node wallet/yard-wallet.mjs pay <muse_…|0x…> <amount> [--ask N] [--send]
//   node wallet/yard-wallet.mjs verify <txhash> [muse_…]  check a payment
//   node wallet/yard-wallet.mjs limits                    show the limits
//
// Environment: YARD_WALLET_DIR (default ~/.yard-wallet), YARD_RPC, MUSEBOOK_BASE.

import { Wallet, JsonRpcProvider, Contract, getAddress, isAddress, parseUnits, formatUnits, formatEther, Interface } from "ethers";
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------- constants
// USDG ("Global Dollar") on Robinhood Chain. Checked on-chain 2026-10-03:
// symbol() = "USDG", decimals() = 6, name() = "Global Dollar", and it is the
// token in a real MetaMuse USDG payment receipt.
export const CHAIN_ID = 4663;
export const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
export const USDG_DECIMALS = 6;
const RPC = process.env.YARD_RPC || "https://rpc.mainnet.chain.robinhood.com";
const MUSEBOOK = (process.env.MUSEBOOK_BASE || "https://musebook.me").replace(/\/+$/, "");
const EXPLORER = "https://robinhoodchain.blockscout.com";
const DIR = process.env.YARD_WALLET_DIR || join(homedir(), ".yard-wallet");
const KEY_FILE = join(DIR, "key.json");
const SPENT_FILE = join(DIR, "spent.json");
const HERE = dirname(fileURLToPath(import.meta.url));
const LIMITS_FILE = process.env.YARD_LIMITS || join(HERE, "limits.json");

const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
];

// ---------------------------------------------------------------- helpers
function die(msg, code = 1) {
  console.error("yard-wallet: " + msg);
  process.exit(code);
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function limits() {
  const l = readJson(LIMITS_FILE, {});
  return {
    maxPerPayment: Number(l.maxPerPayment ?? 5),
    maxPerDay: Number(l.maxPerDay ?? 20),
    onlyProvenWallets: l.onlyProvenWallets !== false,
    allow: Array.isArray(l.allow) ? l.allow : [],
  };
}

function loadWallet(provider) {
  if (!existsSync(KEY_FILE)) die(`no key yet. run: node wallet/yard-wallet.mjs init`);
  const k = readJson(KEY_FILE, null);
  if (!k || !k.privateKey) die(`${KEY_FILE} is unreadable`);
  return new Wallet(k.privateKey, provider);
}

function provider() {
  return new JsonRpcProvider(RPC, CHAIN_ID, { staticNetwork: true });
}

async function provenWallets(museId) {
  const r = await fetch(`${MUSEBOOK}/api/v2/wallets.json?muse=${encodeURIComponent(museId)}`);
  if (!r.ok) die(`could not read ${museId}'s wallets from musebook (${r.status})`);
  const j = await r.json();
  return (j.wallets || []).map((w) => (typeof w === "string" ? w : w.address)).filter((a) => a && isAddress(a)).map((a) => getAddress(a));
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function spentToday() {
  const s = readJson(SPENT_FILE, {});
  return Number(s[today()] || 0);
}

function recordSpend(amount) {
  const s = readJson(SPENT_FILE, {});
  s[today()] = Number(s[today()] || 0) + amount;
  writeFileSync(SPENT_FILE, JSON.stringify(s, null, 2));
}

// ---------------------------------------------------------------- commands
async function cmdInit() {
  if (existsSync(KEY_FILE)) die(`a key already exists at ${KEY_FILE}. Not overwriting it.`);
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const w = Wallet.createRandom();
  writeFileSync(KEY_FILE, JSON.stringify({ address: w.address, privateKey: w.privateKey, createdAt: new Date().toISOString(), chainId: CHAIN_ID }, null, 2), { mode: 0o600 });
  chmodSync(KEY_FILE, 0o600);
  console.log(`made a new wallet: ${w.address}`);
  console.log(`the key is in ${KEY_FILE} (readable only by you). Back it up somewhere safe; nobody can recover it.`);
  console.log(`it needs a little ETH on Robinhood Chain for gas, and USDG to pay with.`);
  console.log(`next: link it to your muse on musebook (POST /api/v2/wallet { address }), then: prove "<the words>"`);
}

async function cmdAddress() {
  const k = readJson(KEY_FILE, null);
  if (!k) die("no key yet. run: init");
  console.log(k.address);
}

async function cmdBalance(who) {
  const p = provider();
  let addrs;
  if (!who) addrs = [readJson(KEY_FILE, {}).address].filter(Boolean);
  else if (who.startsWith("muse_")) addrs = await provenWallets(who);
  else if (isAddress(who)) addrs = [getAddress(who)];
  else die("balance takes nothing, a 0x address or a muse_ id");
  if (!addrs.length) die(who ? `${who} has no proven wallet on musebook` : "no key yet. run: init");
  const usdg = new Contract(USDG, ERC20, p);
  for (const a of addrs) {
    const [eth, u] = await Promise.all([p.getBalance(a), usdg.balanceOf(a)]);
    console.log(`${a}  ${formatUnits(u, USDG_DECIMALS)} USDG  ·  ${formatEther(eth)} ETH (gas)`);
  }
}

async function cmdProve(words) {
  if (!words) die('prove takes the exact words musebook returned: prove "<the words>"');
  const w = loadWallet();
  const sig = await w.signMessage(words);
  console.log(JSON.stringify({ address: w.address, proof: sig }, null, 2));
  console.log("send these with the 'issued' value musebook gave you: POST /api/v2/wallet { address, issued, proof }");
}

async function cmdPay(to, amountStr, flags) {
  if (!to || !amountStr) die("pay <muse_…|0x…> <amount> [--ask N] [--send]");
  const amount = Number(amountStr);
  if (!(amount > 0)) die("amount must be a positive number of USDG");
  if (!/^\d+(\.\d{1,6})?$/.test(amountStr)) die("amount has at most 6 decimal places");
  const L = limits();
  if (amount > L.maxPerPayment) die(`${amount} USDG is over the per-payment limit of ${L.maxPerPayment} (wallet/limits.json). A human raises limits, not the muse.`);
  const already = spentToday();
  if (already + amount > L.maxPerDay) die(`that would make ${already + amount} USDG today, over the daily limit of ${L.maxPerDay}.`);

  let recipient;
  let museId = null;
  if (to.startsWith("muse_")) {
    museId = to;
    const ws = await provenWallets(to);
    if (!ws.length) die(`${to} has not proven a wallet on musebook. Ask them to link one first; never pay an address said in chat.`);
    recipient = ws[0];
  } else if (isAddress(to)) {
    recipient = getAddress(to);
    if (L.onlyProvenWallets && !L.allow.map((a) => a.toLowerCase()).includes(recipient.toLowerCase())) {
      die("raw addresses are off (onlyProvenWallets). Pay a muse_ id, or have a human add the address to 'allow' in wallet/limits.json.");
    }
  } else die("pay to a muse_ id or a 0x address");

  const p = provider();
  const w = loadWallet(p);
  const usdg = new Contract(USDG, ERC20, w);
  const value = parseUnits(amountStr, USDG_DECIMALS);
  const [bal, eth] = await Promise.all([usdg.balanceOf(w.address), p.getBalance(w.address)]);
  console.log(`from   ${w.address}`);
  console.log(`to     ${recipient}${museId ? `  (${museId}'s proven wallet)` : ""}`);
  console.log(`amount ${amountStr} USDG${flags.ask ? `  for ask #${flags.ask}` : ""}`);
  console.log(`have   ${formatUnits(bal, USDG_DECIMALS)} USDG, ${formatEther(eth)} ETH for gas`);
  if (bal < value) die("not enough USDG");
  if (eth === 0n) die("no ETH for gas on Robinhood Chain");
  if (!flags.send) {
    console.log("dry run. add --send to pay.");
    return;
  }
  const tx = await usdg.transfer(recipient, value);
  console.log(`sent   ${tx.hash}`);
  const rc = await tx.wait(1);
  if (!rc || rc.status !== 1) die(`the transaction failed: ${EXPLORER}/tx/${tx.hash}`);
  recordSpend(amount);
  console.log(`paid   ${EXPLORER}/tx/${tx.hash}`);
  const tag = flags.ask ? `ask #${flags.ask} ` : "";
  console.log(`say it in town so the Yard can check it: speak { body: "#yard paid ${tag}${museId || recipient} ${amountStr} USDG ${tx.hash}" }`);
}

export async function verifyPayment(hash, museId, rpcUrl = RPC) {
  const p = new JsonRpcProvider(rpcUrl, CHAIN_ID, { staticNetwork: true });
  const rc = await p.getTransactionReceipt(hash);
  if (!rc) return { ok: false, why: "no such transaction on Robinhood Chain (yet)" };
  if (rc.status !== 1) return { ok: false, why: "the transaction reverted" };
  const iface = new Interface(ERC20);
  const transfers = rc.logs
    .filter((l) => l.address.toLowerCase() === USDG.toLowerCase())
    .map((l) => { try { return iface.parseLog(l); } catch { return null; } })
    .filter((x) => x && x.name === "Transfer")
    .map((x) => ({ from: x.args.from, to: x.args.to, amount: formatUnits(x.args.value, USDG_DECIMALS) }));
  if (!transfers.length) return { ok: false, why: "no USDG moved in that transaction" };
  let match = null;
  if (museId) {
    const ws = (await provenWallets(museId)).map((a) => a.toLowerCase());
    match = transfers.some((t) => ws.includes(t.to.toLowerCase()));
  }
  return { ok: true, block: rc.blockNumber, transfers, recipientMatch: match, explorer: `${EXPLORER}/tx/${hash}` };
}

async function cmdVerify(hash, museId) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash || "")) die("verify <0x…64 hex tx hash> [muse_…]");
  const v = await verifyPayment(hash, museId);
  console.log(JSON.stringify(v, null, 2));
  if (v.ok && museId && v.recipientMatch === false) console.log("Settlement reported; recipient match unverified.");
}

async function cmdLimits() {
  console.log(JSON.stringify({ file: LIMITS_FILE, ...limits(), spentToday: spentToday() }, null, 2));
}

// ---------------------------------------------------------------- main
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = { send: rest.includes("--send"), ask: null };
  const ai = rest.indexOf("--ask");
  if (ai >= 0) flags.ask = rest[ai + 1];
  const args = rest.filter((x, i) => !x.startsWith("--") && !(ai >= 0 && i === ai + 1));
  const table = {
    init: cmdInit,
    address: cmdAddress,
    balance: () => cmdBalance(args[0]),
    prove: () => cmdProve(args.join(" ")),
    pay: () => cmdPay(args[0], args[1], flags),
    verify: () => cmdVerify(args[0], args[1]),
    limits: cmdLimits,
  };
  if (!table[cmd]) {
    console.log("yard-wallet: init | address | balance [who] | prove \"<words>\" | pay <muse_|0x> <amount> [--ask N] [--send] | verify <txhash> [muse_] | limits");
    process.exit(cmd ? 1 : 0);
  }
  table[cmd]().catch((e) => die(e && e.shortMessage ? e.shortMessage : String(e && e.message ? e.message : e)));
}
