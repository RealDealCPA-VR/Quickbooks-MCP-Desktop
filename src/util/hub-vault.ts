/**
 * Hub-held login vault encryption (docs/CONNECTOR_DESIGN.md, "Logins").
 *
 * On the hub, saved QuickBooks passwords are encrypted with AES-256-GCM
 * under a key kept in its own file (mode 600), separate from the vault
 * (credentials.json), so a copy of the vault alone is useless. A password
 * is decrypted only to hand it to a workstation's connector for one login
 * autofill. Format of the stored value: "hub1:" + base64(iv | tag | ciphertext).
 *
 * DPAPI ciphertext (no prefix) is still what the everything-on-one-PC mode
 * stores; it can only be read on the PC that wrote it.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { getCredentialsFilePath, type PasswordProtector } from "./qb-credentials.js";

export const HUB_CIPHER_PREFIX = "hub1:";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** $QB_HUB_KEY_FILE, else `hub-vault.key` beside the credential store. */
export function getHubKeyPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.QB_HUB_KEY_FILE && env.QB_HUB_KEY_FILE.trim()) return env.QB_HUB_KEY_FILE;
  return path.join(path.dirname(getCredentialsFilePath(env)), "hub-vault.key");
}

/** Load the key, creating it (mode 600) on first use. */
export function loadOrCreateHubKey(keyPath: string = getHubKeyPath()): Buffer {
  if (existsSync(keyPath)) {
    const key = Buffer.from(readFileSync(keyPath, "utf8").trim(), "base64");
    if (key.length !== KEY_BYTES) throw new Error(`Hub vault key at ${keyPath} is not a 256-bit key.`);
    return key;
  }
  mkdirSync(path.dirname(keyPath), { recursive: true });
  const key = randomBytes(KEY_BYTES);
  writeFileSync(keyPath, key.toString("base64") + "\n", { mode: 0o600, flag: "wx" });
  try { chmodSync(keyPath, 0o600); } catch { /* best effort on filesystems without modes */ }
  return key;
}

export function hubEncrypt(plain: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return HUB_CIPHER_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

export function hubDecrypt(stored: string, key: Buffer): string {
  if (!stored.startsWith(HUB_CIPHER_PREFIX)) {
    throw new Error("This password was saved on a QuickBooks PC (Windows DPAPI) and can't be read on the hub. Save it again on the control page.");
  }
  const raw = Buffer.from(stored.slice(HUB_CIPHER_PREFIX.length), "base64");
  if (raw.length < IV_BYTES + TAG_BYTES) throw new Error("Saved password is damaged.");
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, IV_BYTES));
  decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
}

/** A PasswordProtector for upsertLogin / the web page in hub mode. */
export function hubPasswordProtector(keyPath: string = getHubKeyPath()): PasswordProtector {
  return async (plain: string) => hubEncrypt(plain, loadOrCreateHubKey(keyPath));
}
