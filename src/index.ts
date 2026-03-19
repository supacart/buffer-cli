#!/usr/bin/env node

import fs from "node:fs/promises";
import readline from "node:readline/promises";
import path from "node:path";
import process from "node:process";
import { Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import packageJson from "../package.json" with { type: "json" };

type Flags = Record<string, string | boolean>;

type ParsedArgs = {
  positionals: string[];
  flags: Flags;
};

type DraftPayload = {
  createdAt: string;
  channelHint: string | null;
  text: string;
};

type Channel = {
  id: string;
  name: string;
  service: string;
  raw: unknown;
};

type SupportedService = "facebook" | "instagram" | "linkedin" | "twitter" | "pinterest" | "googlebusiness" | "youtube" | "mastodon" | "startPage" | "threads" | "bluesky" | "tiktok";

type GraphQLPayload<T> = {
  data?: T;
  errors?: Array<{ message: string }>;
  error?: { message?: string } | string;
  message?: string;
};

type BufferPost = {
  id: string;
  text: string;
  status?: string;
  sentAt?: string | null;
  externalLink?: string | null;
};

type CreatePostResult = {
  createPost?: {
    post?: BufferPost;
    message?: string;
  };
};

type ShellName = "zsh" | "bash";

type SetupConfig = {
  apiKey: string;
  organizationId: string;
  accessToken?: string;
};

const BUFFER_GRAPHQL_URL = "https://api.buffer.com";
const BUFFER_LEGACY_BASE_URL = "https://api.bufferapp.com/1";
const DEFAULT_DRAFT_DIR = path.join(process.cwd(), ".social", "drafts");
const BUFFER_SETUP_START = "# >>> buffer-cli >>>";
const BUFFER_SETUP_END = "# <<< buffer-cli <<<";

async function main(): Promise<void> {
  const { positionals, flags } = parseArgs(process.argv.slice(2));

  if (flags.version || flags.v) {
    console.log(packageJson.version);
    return;
  }

  const command = positionals[0] ?? "help";

  try {
    switch (command) {
      case "help":
        printHelp();
        break;
      case "version":
        console.log(packageJson.version);
        break;
      case "draft":
        await createDraft(flags);
        break;
      case "drafts":
        await listDrafts(flags);
        break;
      case "setup":
        await runSetup(flags);
        break;
      case "list-channels":
        await listChannels(flags);
        break;
      case "schedule":
        await createBufferPost("schedule", flags);
        break;
      case "publish-now":
        await createBufferPost("publish-now", flags);
        break;
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  } catch (error) {
    console.error(`Error: ${getErrorMessage(error)}`);
    process.exitCode = 1;
  }
}

function printHelp(): void {
  console.log(`Buffer CLI

Usage:
  buffer help
  buffer version
  buffer setup [--shell zsh|bash] [--profile PATH]
  buffer list-channels [--org ORGANIZATION_ID] [--json]
  buffer draft --text "Post copy" [--slug launch-post] [--channel-hint facebook]
  buffer drafts [--json]
  buffer schedule --channel CHANNEL (--text "Post copy" | --draft PATH) [--type post|story|reel] --at 2026-03-20T09:00:00Z
  buffer publish-now --channel CHANNEL (--text "Post copy" | --draft PATH) [--type post|story|reel]

Environment:
  BUFFER_API_KEY       Required for schedule and publish-now, and preferred for list-channels
  BUFFER_ACCESS_TOKEN  Optional fallback for legacy profile listing
  BUFFER_ORGANIZATION_ID Optional for GraphQL channel listing
  SOCIAL_DRAFT_DIR     Optional override for local drafts directory

Flags:
  --version, -v       Print the CLI version
`);
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Flags = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const key = arg.slice(2);
    const next = argv[index + 1];

    if (!next || next.startsWith("--")) {
      flags[key] = true;
      continue;
    }

    flags[key] = next;
    index += 1;
  }

  return { positionals, flags };
}

function getDraftDir(flags: Flags): string {
  return path.resolve(getStringFlag(flags["draft-dir"]) || process.env.SOCIAL_DRAFT_DIR || DEFAULT_DRAFT_DIR);
}

function requireValue(value: string | undefined, message: string): string {
  if (!value) {
    throw new Error(message);
  }

  return value;
}

function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "post"
  );
}

function getStringFlag(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function looksLikeChannelId(value: string): boolean {
  return /^[a-f0-9]{24}$/i.test(value);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getHomeDir(): string {
  return requireValue(process.env.HOME, "Could not determine the current home directory.");
}

function detectShell(value: string | undefined): ShellName {
  const shell = path.basename(value || "");

  if (shell === "bash") {
    return "bash";
  }

  return "zsh";
}

function getDefaultProfilePath(shell: ShellName): string {
  return path.join(getHomeDir(), shell === "bash" ? ".bashrc" : ".zshrc");
}

function getShellProfile(flags: Flags): { shell: ShellName; profilePath: string } {
  const shellFlag = getStringFlag(flags.shell);
  const shell = shellFlag === "bash" || shellFlag === "zsh" ? shellFlag : detectShell(process.env.SHELL);
  const profileFlag = getStringFlag(flags.profile);

  return {
    shell,
    profilePath: path.resolve(profileFlag || getDefaultProfilePath(shell))
  };
}

async function runSetup(flags: Flags): Promise<void> {
  const { shell, profilePath } = getShellProfile(flags);
  const setupConfig = await collectSetupConfig(flags);
  const profileBlock = buildProfileBlock(setupConfig);
  const currentProfile = await readOptionalFile(profilePath);
  const nextProfile = upsertProfileBlock(currentProfile, profileBlock);

  await fs.writeFile(profilePath, nextProfile, "utf8");

  console.log(`Saved Buffer credentials to ${profilePath}`);
  console.log("");
  console.log("Next step:");
  console.log(`  source ${profilePath}`);
  console.log("");
  console.log("Then test:");
  console.log("  buffer list-channels");
  console.log("");
  console.log(`Shell detected: ${shell}`);
}

async function collectSetupConfig(flags: Flags): Promise<SetupConfig> {
  const apiKeyFlag = getStringFlag(flags["api-key"]);
  const organizationIdFlag = getStringFlag(flags.org);
  const accessTokenFlag = getStringFlag(flags["access-token"]);
  const shouldPrompt = process.stdin.isTTY && process.stdout.isTTY;

  const apiKey = apiKeyFlag || process.env.BUFFER_API_KEY || (shouldPrompt ? await promptSecret("Buffer API key: ") : undefined);
  const organizationId =
    organizationIdFlag ||
    process.env.BUFFER_ORGANIZATION_ID ||
    (shouldPrompt ? await promptValue("Buffer organization ID: ") : undefined);
  let accessToken = accessTokenFlag || process.env.BUFFER_ACCESS_TOKEN;

  if (!accessToken && shouldPrompt) {
    accessToken = await promptValue("Optional Buffer access token (press Enter to skip): ");
  }

  return {
    apiKey: requireValue(apiKey, "Missing Buffer API key. Pass --api-key or run setup in an interactive terminal."),
    organizationId: requireValue(
      organizationId,
      "Missing Buffer organization ID. Pass --org or run setup in an interactive terminal."
    ),
    accessToken: accessToken?.trim() ? accessToken.trim() : undefined
  };
}

async function promptValue(prompt: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
    return (await rl.question(prompt)).trim();
  } finally {
    rl.close();
  }
}

async function promptSecret(prompt: string): Promise<string> {
  let muted = false;
  const mutableStdout = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) {
        process.stdout.write(chunk, encoding as BufferEncoding);
      }
      callback();
    }
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: mutableStdout
  });

  try {
    process.stdout.write(prompt);
    muted = true;
    const value = await rl.question("");
    muted = false;
    process.stdout.write("\n");
    return value.trim();
  } finally {
    rl.close();
  }
}

async function readOptionalFile(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    const message = getErrorMessage(error);
    if (message.includes("ENOENT")) {
      return "";
    }
    throw error;
  }
}

function buildProfileBlock(config: SetupConfig): string {
  const lines = [
    BUFFER_SETUP_START,
    "# Added by buffer setup",
    `export BUFFER_API_KEY=${JSON.stringify(config.apiKey)}`,
    `export BUFFER_ORGANIZATION_ID=${JSON.stringify(config.organizationId)}`
  ];

  if (config.accessToken) {
    lines.push(`export BUFFER_ACCESS_TOKEN=${JSON.stringify(config.accessToken)}`);
  }

  lines.push(BUFFER_SETUP_END);

  return lines.join("\n");
}

function upsertProfileBlock(currentProfile: string, profileBlock: string): string {
  const trimmedCurrent = currentProfile.trimEnd();
  const blockPattern = new RegExp(`${escapeRegExp(BUFFER_SETUP_START)}[\\s\\S]*?${escapeRegExp(BUFFER_SETUP_END)}`, "m");

  if (blockPattern.test(trimmedCurrent)) {
    return `${trimmedCurrent.replace(blockPattern, profileBlock)}\n`;
  }

  if (trimmedCurrent.length === 0) {
    return `${profileBlock}\n`;
  }

  return `${trimmedCurrent}\n\n${profileBlock}\n`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

async function readDraftText(draftPath: string): Promise<string> {
  const payload = await readDraftPayload(draftPath);

  return payload.text;
}

async function readDraftPayload(draftPath: string): Promise<DraftPayload> {
  const raw = await fs.readFile(path.resolve(draftPath), "utf8");
  const parsed = JSON.parse(raw) as Partial<DraftPayload>;

  if (!parsed.text) {
    throw new Error(`Draft file has no text: ${draftPath}`);
  }

  return {
    createdAt: String(parsed.createdAt ?? ""),
    channelHint: parsed.channelHint ?? null,
    text: parsed.text
  };
}

async function resolvePostText(flags: Flags): Promise<string> {
  const text = getStringFlag(flags.text);
  const draft = getStringFlag(flags.draft);
  const file = getStringFlag(flags.file);

  if (text) {
    return text.trim();
  }

  if (draft) {
    return readDraftText(draft);
  }

  if (file) {
    return (await fs.readFile(path.resolve(file), "utf8")).trim();
  }

  throw new Error("Provide post content with --text, --draft, or --file.");
}

async function createDraft(flags: Flags): Promise<void> {
  const text = await resolvePostText(flags);
  const draftDir = getDraftDir(flags);
  const date = new Date().toISOString().slice(0, 10);
  const slug = slugify(getStringFlag(flags.slug) || text.split(/\s+/).slice(0, 8).join(" "));
  const filename = `${date}_${slug}.json`;
  const draftPath = path.join(draftDir, filename);

  const payload: DraftPayload = {
    createdAt: new Date().toISOString(),
    channelHint: getStringFlag(flags["channel-hint"]) ?? null,
    text
  };

  await ensureDir(draftDir);
  await fs.writeFile(draftPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  console.log(draftPath);
}

async function listDrafts(flags: Flags): Promise<void> {
  const draftDir = getDraftDir(flags);
  await ensureDir(draftDir);
  const entries = await fs.readdir(draftDir, { withFileTypes: true });
  const drafts: Array<{
    path: string;
    channelHint?: string | null;
    createdAt?: string;
    textPreview: string;
  }> = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }

    const draftPath = path.join(draftDir, entry.name);
    const raw = await fs.readFile(draftPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<DraftPayload>;
    drafts.push({
      path: draftPath,
      channelHint: parsed.channelHint,
      createdAt: parsed.createdAt,
      textPreview: String(parsed.text || "").slice(0, 120)
    });
  }

  drafts.sort((left, right) => left.path.localeCompare(right.path));

  if (flags.json) {
    console.log(JSON.stringify(drafts, null, 2));
    return;
  }

  if (drafts.length === 0) {
    console.log("No drafts found.");
    return;
  }

  for (const draft of drafts) {
    console.log(`${draft.path}`);
    console.log(`  created: ${draft.createdAt ?? "-"}`);
    console.log(`  channel: ${draft.channelHint ?? "-"}`);
    console.log(`  preview: ${draft.textPreview}`);
  }
}

async function listChannels(flags: Flags): Promise<void> {
  const channels = await getChannels(flags);

  printChannels(channels, flags);
}

async function getChannels(flags: Flags): Promise<Channel[]> {
  const apiKey = process.env.BUFFER_API_KEY;
  const accessToken = process.env.BUFFER_ACCESS_TOKEN;
  const organizationId = getStringFlag(flags.org) || process.env.BUFFER_ORGANIZATION_ID;
  const errors: string[] = [];

  if (apiKey && organizationId) {
    try {
      const data = await bufferGraphQLRequest<{ channels?: unknown[] }>({
        apiKey,
        query: `query ListChannels {
          channels(input: { organizationId: ${JSON.stringify(organizationId)} }) {
            id
            name
            service
            displayName
            descriptor
          }
        }`
      });
      const channels = normalizeChannels(data);

      if (channels.length > 0) {
        return channels;
      }
    } catch (error) {
      errors.push(`GraphQL channels query: ${getErrorMessage(error)}`);
    }
  } else if (apiKey && !organizationId) {
    errors.push("GraphQL channels query needs an organizationId. Set BUFFER_ORGANIZATION_ID or pass --org.");
  }

  const bearerCandidates = [accessToken, apiKey].filter((value): value is string => Boolean(value));

  for (const token of bearerCandidates) {
    try {
      const response = await fetch(`${BUFFER_LEGACY_BASE_URL}/profiles.json`, {
        headers: {
          Authorization: `Bearer ${token}`
        }
      });
      const data = await parseJsonResponse<unknown>(response);
      const channels = normalizeLegacyProfiles(data);

      if (channels.length > 0) {
        return channels;
      }
    } catch (error) {
      errors.push(`Legacy profiles with bearer token: ${getErrorMessage(error)}`);
    }
  }

  if (accessToken) {
    try {
      const response = await fetch(
        `${BUFFER_LEGACY_BASE_URL}/profiles.json?access_token=${encodeURIComponent(accessToken)}`
      );
      const data = await parseJsonResponse<unknown>(response);
      const channels = normalizeLegacyProfiles(data);

      if (channels.length > 0) {
        return channels;
      }
    } catch (error) {
      errors.push(`Legacy profiles with query token: ${getErrorMessage(error)}`);
    }
  }

  throw new Error(
    `Unable to list channels. ${
      errors.length > 0 ? `Tried:\n- ${errors.join("\n- ")}` : "No valid authentication method was available."
    }`
  );
}

function findChannelsByAlias(channels: Channel[], alias: string): Channel[] {
  const normalizedAlias = normalizeAlias(alias);

  return channels.filter((channel) => {
    const candidates = [
      channel.service,
      channel.name,
      getDescriptor(channel.raw),
      getFormattedUsername(channel.raw)
    ];

    return candidates.some((candidate) => normalizeAlias(candidate) === normalizedAlias);
  });
}

function normalizeAlias(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function getDescriptor(raw: unknown): string {
  if (!raw || typeof raw !== "object") {
    return "";
  }

  const record = raw as Record<string, unknown>;
  return String(record.descriptor ?? "");
}

function getFormattedUsername(raw: unknown): string {
  if (!raw || typeof raw !== "object") {
    return "";
  }

  const record = raw as Record<string, unknown>;
  return String(record.formatted_username ?? record.service_username ?? "");
}

function normalizeChannels(data: { channels?: unknown[]; accounts?: unknown[] | { nodes?: unknown[] } }): Channel[] {
  const candidates = [data.channels, data.accounts, data.accounts && "nodes" in data.accounts ? data.accounts.nodes : undefined];

  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) {
      continue;
    }

    return candidate
      .filter(Boolean)
      .map((channel) => {
        const record = channel as Record<string, unknown>;
        return {
          id: String(record.id ?? ""),
          name: String(
            record.displayName ??
              record.name ??
              record.descriptor ??
              record.handle ??
              record.username ??
              "unknown"
          ),
          service: String(record.service ?? record.type ?? "unknown"),
          raw: channel
        };
      })
      .filter((channel) => channel.id.length > 0);
  }

  return [];
}

function normalizeLegacyProfiles(data: unknown): Channel[] {
  if (!Array.isArray(data)) {
    return [];
  }

  return data
    .filter(Boolean)
    .map((profile) => {
      const record = profile as Record<string, unknown>;
      return {
        id: String(record.id ?? ""),
        name: String(record.formatted_username ?? record.service_username ?? record.service ?? "unknown"),
        service: String(record.service ?? "unknown"),
        raw: profile
      };
    })
    .filter((channel) => channel.id.length > 0);
}

function printChannels(channels: Channel[], flags: Flags): void {
  if (flags.json) {
    console.log(JSON.stringify(channels, null, 2));
    return;
  }

  for (const channel of channels) {
    console.log(`${channel.id}\t${channel.service}\t${channel.name}`);
  }
}

async function createBufferPost(mode: "schedule" | "publish-now", flags: Flags): Promise<void> {
  const apiKey = requireValue(process.env.BUFFER_API_KEY, "Set BUFFER_API_KEY first.");
  const channelInput = requireValue(
    getStringFlag(flags.channel),
    "Provide --channel with the Buffer channel ID or a channel alias like facebook."
  );
  const channel = await resolveChannel(apiKey, channelInput, flags);
  const channelId = channel.id;
  const text = await resolvePostText(flags);
  const metadataClause = await buildMetadataClause({ flags, channel });

  let bufferMode = "shareNow";
  let dueAtClause = "";

  if (mode === "schedule") {
    bufferMode = "customSchedule";
    const dueAt = requireValue(
      getStringFlag(flags.at),
      "Provide --at with an ISO datetime, for example 2026-03-20T09:00:00Z."
    );
    dueAtClause = `, dueAt: ${JSON.stringify(new Date(dueAt).toISOString())}`;
  }

  const query = `mutation CreatePost {
    createPost(input: {
      text: ${JSON.stringify(text)},
      channelId: ${JSON.stringify(channelId)},
      schedulingType: automatic,
      mode: ${bufferMode}${dueAtClause}${metadataClause}
    }) {
      ... on PostActionSuccess {
        post {
          id
          text
          status
          sentAt
          externalLink
        }
      }
      ... on MutationError {
        message
      }
    }
  }`;

  const data = await bufferGraphQLRequest<CreatePostResult>({
    apiKey,
    query
  });

  const result = data.createPost;

  if (!result) {
    throw new Error("Buffer returned no createPost payload.");
  }

  if (result.message) {
    throw new Error(result.message);
  }

  if (mode === "publish-now" && result.post?.id && !result.post.externalLink) {
    const latestPost = await waitForPublishedPostUrl(apiKey, result.post.id);
    if (latestPost?.externalLink) {
      result.post = latestPost;
    }
  }

  console.log(JSON.stringify(result, null, 2));

  if (result.post?.externalLink) {
    console.log("");
    console.log(`Posted URL: ${result.post.externalLink}`);
  }
}

async function buildMetadataClause({
  flags,
  channel
}: {
  flags: Flags;
  channel: Channel;
}): Promise<string> {
  const typeFlag = getStringFlag(flags.type);
  const channelHint = await resolveChannelHint({ channel, flags });

  if (channelHint !== "facebook") {
    return "";
  }

  const facebookType = validateFacebookPostType(typeFlag || "post");

  return `, metadata: { facebook: { type: ${facebookType} } }`;
}

async function resolveChannelHint({
  channel,
  flags
}: {
  channel: Channel;
  flags: Flags;
}): Promise<string | undefined> {
  const explicitHint = getStringFlag(flags["channel-hint"]);
  if (explicitHint) {
    return explicitHint;
  }

  const draftPath = getStringFlag(flags.draft);
  if (draftPath) {
    const draft = await readDraftPayload(draftPath);
    if (draft.channelHint) {
      return draft.channelHint;
    }
  }

  return channel?.service;
}

function validateFacebookPostType(value: string): "post" | "story" | "reel" {
  if (value === "post" || value === "story" || value === "reel") {
    return value;
  }

  throw new Error("Invalid Facebook post type. Use --type post, --type story, or --type reel.");
}

async function getChannelById(apiKey: string, channelId: string): Promise<Channel | null> {
  const data = await bufferGraphQLRequest<{ channel?: unknown }>({
    apiKey,
    query: `query GetChannel {
      channel(input: { id: ${JSON.stringify(channelId)} }) {
        id
        name
        service
        displayName
        descriptor
      }
    }`
  });

  if (!data.channel || typeof data.channel !== "object") {
    return null;
  }

  const record = data.channel as Record<string, unknown>;

  return {
    id: String(record.id ?? ""),
    name: String(record.displayName ?? record.name ?? record.descriptor ?? "unknown"),
    service: String(record.service ?? "unknown"),
    raw: data.channel
  };
}

async function getPostById(apiKey: string, postId: string): Promise<BufferPost | null> {
  const data = await bufferGraphQLRequest<{ post?: unknown }>({
    apiKey,
    query: `query GetPost {
      post(input: { id: ${JSON.stringify(postId)} }) {
        id
        text
        status
        sentAt
        externalLink
      }
    }`
  });

  if (!data.post || typeof data.post !== "object") {
    return null;
  }

  const record = data.post as Record<string, unknown>;

  return {
    id: String(record.id ?? ""),
    text: String(record.text ?? ""),
    status: typeof record.status === "string" ? record.status : undefined,
    sentAt: typeof record.sentAt === "string" ? record.sentAt : null,
    externalLink: typeof record.externalLink === "string" ? record.externalLink : null
  };
}

async function waitForPublishedPostUrl(apiKey: string, postId: string): Promise<BufferPost | null> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const post = await getPostById(apiKey, postId);
    if (post?.externalLink) {
      return post;
    }

    await sleep(1500);
  }

  return null;
}

async function resolveChannel(apiKey: string, channelInput: string, flags: Flags): Promise<Channel> {
  if (looksLikeChannelId(channelInput)) {
    const channel = await getChannelById(apiKey, channelInput);
    if (!channel) {
      throw new Error(`Could not find a Buffer channel with ID ${channelInput}.`);
    }

    return channel;
  }

  const channels = await getChannels(flags);
  const matches = findChannelsByAlias(channels, channelInput);

  if (matches.length === 1) {
    return matches[0];
  }

  if (matches.length > 1) {
    const options = matches.map((channel) => `${channel.id}\t${channel.service}\t${channel.name}`).join("\n");
    throw new Error(
      `Channel alias "${channelInput}" matched multiple channels. Use a channel ID instead.\n${options}`
    );
  }

  throw new Error(`Could not resolve channel alias "${channelInput}". Run "buffer list-channels" to see available channels.`);
}

async function bufferGraphQLRequest<T>({ apiKey, query }: { apiKey: string; query: string }): Promise<T> {
  const response = await fetch(BUFFER_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({ query })
  });

  const payload = await parseJsonResponse<GraphQLPayload<T>>(response);

  if (payload.errors?.length) {
    throw new Error(`GraphQL error: ${payload.errors.map((error) => error.message).join("; ")}`);
  }

  if (!payload.data) {
    throw new Error("Buffer returned no data.");
  }

  return payload.data;
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  let payload: unknown;

  try {
    payload = text ? (JSON.parse(text) as unknown) : {};
  } catch {
    throw new Error(`Expected JSON response but received: ${text.slice(0, 200)}`);
  }

  if (!response.ok) {
    const record = (payload ?? {}) as Record<string, unknown>;
    const nestedError =
      typeof record.error === "object" && record.error && "message" in record.error
        ? String((record.error as { message?: unknown }).message ?? "")
        : undefined;
    const errorMessage =
      nestedError ||
      (typeof record.error === "string" ? record.error : undefined) ||
      (typeof record.message === "string" ? record.message : undefined) ||
      text ||
      `${response.status} ${response.statusText}`;
    throw new Error(errorMessage);
  }

  return payload as T;
}

await main();
