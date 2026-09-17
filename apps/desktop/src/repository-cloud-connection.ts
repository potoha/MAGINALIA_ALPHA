/**
 * Pure codec for the non-secret .git/maginalia-connection.json contract.
 * Filesystem ownership and atomic persistence belong to the host boundary;
 * this module only validates and serializes an already bounded value.
 */

import { TextDecoder, TextEncoder } from "node:util";
import type { VerifiedPrivateRemote } from "./repository-github";

export const MAX_REPOSITORY_CLOUD_CONNECTION_BYTES = 16 * 1024;

const CONNECTION_KEYS = ["id", "nodeId", "owner", "name", "url", "private"] as const;
const MAX_OWNER_LENGTH = 39;
const MAX_REPOSITORY_NAME_LENGTH = 100;
const MAX_NODE_ID_LENGTH = 512;
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const REPOSITORY_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;
const NODE_ID_PATTERN = /^[A-Za-z0-9+/=_:.-]+$/;
const GITHUB_WEB_ORIGIN = "https://github.com";

export interface RepositoryCloudConnection extends VerifiedPrivateRemote {}

export type RepositoryCloudConnectionErrorCode =
  | "invalid-connection"
  | "connection-too-large";

const ERROR_MESSAGES: Readonly<Record<RepositoryCloudConnectionErrorCode, string>> = Object.freeze({
  "invalid-connection": "The repository cloud connection metadata is invalid.",
  "connection-too-large": "The repository cloud connection metadata is too large.",
});

export class RepositoryCloudConnectionError extends Error {
  public readonly code: RepositoryCloudConnectionErrorCode;
  public readonly userMessage: string;

  public constructor(code: RepositoryCloudConnectionErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "RepositoryCloudConnectionError";
    this.code = code;
    this.userMessage = this.message;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function fail(code: RepositoryCloudConnectionErrorCode): never {
  throw new RepositoryCloudConnectionError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function ownDataDescriptor(value: Record<string, unknown>, key: string): PropertyDescriptor | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor : undefined;
}

function ownValue(value: Record<string, unknown>, key: string): unknown {
  return ownDataDescriptor(value, key)?.value;
}

function isPlainConnectionRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  try {
    return Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
}

function hasExactConnectionKeys(value: unknown): value is Record<string, unknown> {
  if (!isPlainConnectionRecord(value)) return false;
  try {
    const keys = Reflect.ownKeys(value);
    return keys.length === CONNECTION_KEYS.length
      && keys.every((key) => typeof key === "string" && CONNECTION_KEYS.includes(key as typeof CONNECTION_KEYS[number]))
      && CONNECTION_KEYS.every((key) => ownDataDescriptor(value, key) !== undefined);
  } catch {
    return false;
  }
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isSafeOwner(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_OWNER_LENGTH
    && OWNER_PATTERN.test(value);
}

function isSafeRepositoryName(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_REPOSITORY_NAME_LENGTH
    && value !== "."
    && value !== ".."
    && REPOSITORY_NAME_PATTERN.test(value);
}

function isSafeNodeId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_NODE_ID_LENGTH
    && NODE_ID_PATTERN.test(value);
}

function canonicalUrl(owner: string, name: string): string {
  return `${GITHUB_WEB_ORIGIN}/${owner}/${name}.git`;
}

function isCanonicalUrl(value: unknown, owner: string, name: string): value is string {
  const expected = canonicalUrl(owner, name);
  if (value !== expected) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:"
      && parsed.hostname === "github.com"
      && parsed.port === ""
      && parsed.username === ""
      && parsed.password === ""
      && parsed.search === ""
      && parsed.hash === ""
      && parsed.pathname === `/${owner}/${name}.git`;
  } catch {
    return false;
  }
}

function validateConnection(value: unknown): RepositoryCloudConnection {
  try {
    if (!hasExactConnectionKeys(value)) fail("invalid-connection");
    const id = ownValue(value, "id");
    const nodeId = ownValue(value, "nodeId");
    const owner = ownValue(value, "owner");
    const name = ownValue(value, "name");
    const url = ownValue(value, "url");
    if (!isPositiveSafeInteger(id)
      || !isSafeNodeId(nodeId)
      || !isSafeOwner(owner)
      || !isSafeRepositoryName(name)
      || ownValue(value, "private") !== true
      || !isCanonicalUrl(url, owner, name)) {
      fail("invalid-connection");
    }
    return Object.freeze({ id, nodeId, owner, name, url, private: true });
  } catch (error) {
    if (error instanceof RepositoryCloudConnectionError) throw error;
    fail("invalid-connection");
  }
}

function encodeBoundedJson(value: string): Uint8Array {
  // Reject a large string before TextEncoder allocates a proportionally large
  // temporary buffer. Valid contract fields are ASCII, so this character cap
  // is conservative for any non-ASCII malformed input as well.
  if (value.length > MAX_REPOSITORY_CLOUD_CONNECTION_BYTES) fail("connection-too-large");
  let bytes: Uint8Array;
  try {
    bytes = new TextEncoder().encode(value);
  } catch {
    fail("invalid-connection");
  }
  if (bytes.byteLength > MAX_REPOSITORY_CLOUD_CONNECTION_BYTES) fail("connection-too-large");
  return bytes;
}

/** Parse and strictly validate the UTF-8 JSON text of a connection record. */
export function parseRepositoryCloudConnection(text: string): RepositoryCloudConnection {
  if (typeof text !== "string") fail("invalid-connection");
  const bytes = encodeBoundedJson(text);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail("invalid-connection");
  }
  return validateConnection(value);
}

/** Validate and serialize a connection in the legacy stable field order. */
export function serializeRepositoryCloudConnection(value: unknown): string {
  const connection = validateConnection(value);
  let text: string;
  try {
    text = `${JSON.stringify({
      id: connection.id,
      nodeId: connection.nodeId,
      owner: connection.owner,
      name: connection.name,
      url: connection.url,
      private: true,
    }, null, 2)}\n`;
  } catch {
    fail("invalid-connection");
  }
  encodeBoundedJson(text);
  return text;
}
