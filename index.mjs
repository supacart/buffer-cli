#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import packageJson from "./package.json" with { type: "json" };

const BUFFER_GRAPHQL_URL = "https://api.buffer.com";
const BUFFER_LEGACY_BASE_URL = "https://api.bufferapp.com/1";
const DEFAULT_DRAFT_DIR = path.join(process.cwd(), ".social", "drafts");

async function main() {
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
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}

function printHelp() {
  console.log(`Buffer CLI

Usage:
  pnpm social help
  pnpm social version
  pnpm social list-channels [--org ORGANIZATION_ID] [--json]
  pnpm social draft --text "Post copy" [--slug launch-post] [--channel-hint facebook]
  pnpm social drafts [--json]
  pnpm social schedule --channel CHANNEL_ID (--text "Post copy" | --draft PATH) --at 2026-03-20T09:00:00Z
  pnpm social publish-now --channel CHANNEL_ID (--text "Post copy" | --draft PATH)

Environment:
  BUFFER_API_KEY       Required for schedule and publish-now, and preferred for list-channels
  BUFFER_ACCESS_TOKEN  Optional fallback for legacy profile listing
  BUFFER_ORGANIZATION_ID Optional for GraphQL channel listing
  SOCIAL_DRAFT_DIR     Optional override for local drafts directory

Flags:
  --version, -v       Print the CLI version
`);
}

function parseArgs(argv) {
  const positionals = [];
  const flags = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const key = arg.slice(2);
    const next = argv[i + 1];

    if (!next || next.startsWith("--")) {
      flags[key] = true;
      continue;
    }

    flags[key] = next;
    i += 1;
  }

  return { positionals, flags };
}

function getDraftDir(flags) {
  return path.resolve(flags["draft-dir"] || process.env.SOCIAL_DRAFT_DIR || DEFAULT_DRAFT_DIR);
}

function requireValue(value, message) {
  if (!value) {
    throw new Error(message);
  }

  return value;
}

function slugify(input) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "post";
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function readDraftText(draftPath) {
  const raw = await fs.readFile(path.resolve(draftPath), "utf8");
  const parsed = JSON.parse(raw);

  if (!parsed.text) {
    throw new Error(`Draft file has no text: ${draftPath}`);
  }

  return parsed.text;
}

async function resolvePostText(flags) {
  if (flags.text) {
    return String(flags.text).trim();
  }

  if (flags.draft) {
    return readDraftText(flags.draft);
  }

  if (flags.file) {
    return (await fs.readFile(path.resolve(flags.file), "utf8")).trim();
  }

  throw new Error("Provide post content with --text, --draft, or --file.");
}

async function createDraft(flags) {
  const text = await resolvePostText(flags);
  const draftDir = getDraftDir(flags);
  const date = new Date().toISOString().slice(0, 10);
  const slug = slugify(flags.slug || text.split(/\s+/).slice(0, 8).join(" "));
  const filename = `${date}_${slug}.json`;
  const draftPath = path.join(draftDir, filename);

  const payload = {
    createdAt: new Date().toISOString(),
    channelHint: flags["channel-hint"] || null,
    text
  };

  await ensureDir(draftDir);
  await fs.writeFile(draftPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  console.log(draftPath);
}

async function listDrafts(flags) {
  const draftDir = getDraftDir(flags);
  await ensureDir(draftDir);
  const entries = await fs.readdir(draftDir, { withFileTypes: true });
  const drafts = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }

    const draftPath = path.join(draftDir, entry.name);
    const raw = await fs.readFile(draftPath, "utf8");
    const parsed = JSON.parse(raw);
    drafts.push({
      path: draftPath,
      channelHint: parsed.channelHint,
      createdAt: parsed.createdAt,
      textPreview: String(parsed.text || "").slice(0, 120)
    });
  }

  drafts.sort((a, b) => a.path.localeCompare(b.path));

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

async function listChannels(flags) {
  const apiKey = process.env.BUFFER_API_KEY;
  const accessToken = process.env.BUFFER_ACCESS_TOKEN;
  const organizationId = flags.org || process.env.BUFFER_ORGANIZATION_ID;
  const errors = [];

  if (apiKey && organizationId) {
    try {
      const data = await bufferGraphQLRequest({
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
        printChannels(channels, flags);
        return;
      }
    } catch (error) {
      errors.push(`GraphQL channels query: ${error.message}`);
    }
  } else if (apiKey && !organizationId) {
    errors.push(
      "GraphQL channels query needs an organizationId. Set BUFFER_ORGANIZATION_ID or pass --org."
    );
  }

  const bearerCandidates = [accessToken, apiKey].filter(Boolean);

  for (const token of bearerCandidates) {
    try {
      const response = await fetch(`${BUFFER_LEGACY_BASE_URL}/profiles.json`, {
        headers: {
          Authorization: `Bearer ${token}`
        }
      });
      const data = await parseJsonResponse(response);
      const channels = normalizeLegacyProfiles(data);

      if (channels.length > 0) {
        printChannels(channels, flags);
        return;
      }
    } catch (error) {
      errors.push(`Legacy profiles with bearer token: ${error.message}`);
    }
  }

  if (accessToken) {
    try {
      const response = await fetch(
        `${BUFFER_LEGACY_BASE_URL}/profiles.json?access_token=${encodeURIComponent(accessToken)}`
      );
      const data = await parseJsonResponse(response);
      const channels = normalizeLegacyProfiles(data);

      if (channels.length > 0) {
        printChannels(channels, flags);
        return;
      }
    } catch (error) {
      errors.push(`Legacy profiles with query token: ${error.message}`);
    }
  }

  throw new Error(
    `Unable to list channels. ${
      errors.length > 0 ? `Tried:\n- ${errors.join("\n- ")}` : "No valid authentication method was available."
    }`
  );
}

function normalizeChannels(data) {
  const candidates = [
    data?.channels,
    data?.channels?.nodes,
    data?.channels,
    data?.accounts?.nodes,
    data?.accounts
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate
        .filter(Boolean)
        .map((channel) => ({
          id: channel.id,
          name:
            channel.displayName ||
            channel.name ||
            channel.descriptor ||
            channel.handle ||
            channel.username ||
            "unknown",
          service: channel.service || channel.type || "unknown",
          raw: channel
        }));
    }
  }

  return [];
}

function normalizeLegacyProfiles(data) {
  if (!Array.isArray(data)) {
    return [];
  }

  return data
    .filter(Boolean)
    .map((profile) => ({
      id: profile.id,
      name: profile.formatted_username || profile.service_username || profile.service || "unknown",
      service: profile.service,
      raw: profile
    }));
}

function printChannels(channels, flags) {
  if (flags.json) {
    console.log(JSON.stringify(channels, null, 2));
    return;
  }

  for (const channel of channels) {
    console.log(`${channel.id}\t${channel.service}\t${channel.name}`);
  }
}

function isLikelySchemaError(error) {
  return /graphql/i.test(error.message) || /Cannot query field/i.test(error.message);
}

async function createBufferPost(mode, flags) {
  const apiKey = requireValue(process.env.BUFFER_API_KEY, "Set BUFFER_API_KEY first.");
  const channelId = requireValue(flags.channel, "Provide --channel with the Buffer channel ID.");
  const text = await resolvePostText(flags);

  let bufferMode;
  let dueAtClause = "";

  if (mode === "publish-now") {
    bufferMode = "shareNow";
  } else {
    bufferMode = "customSchedule";
    const dueAt = requireValue(flags.at, "Provide --at with an ISO datetime, for example 2026-03-20T09:00:00Z.");
    dueAtClause = `, dueAt: ${JSON.stringify(new Date(dueAt).toISOString())}`;
  }

  const query = `mutation CreatePost {
    createPost(input: {
      text: ${JSON.stringify(text)},
      channelId: ${JSON.stringify(channelId)},
      schedulingType: automatic,
      mode: ${bufferMode}${dueAtClause}
    }) {
      ... on PostActionSuccess {
        post {
          id
          text
        }
      }
      ... on MutationError {
        message
      }
    }
  }`;

  const data = await bufferGraphQLRequest({
    apiKey,
    query
  });

  const result = data?.createPost;

  if (!result) {
    throw new Error("Buffer returned no createPost payload.");
  }

  if (result.message) {
    throw new Error(result.message);
  }

  console.log(JSON.stringify(result, null, 2));
}

async function bufferGraphQLRequest({ apiKey, query }) {
  const response = await fetch(BUFFER_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({ query })
  });

  const payload = await parseJsonResponse(response);

  if (payload.errors?.length) {
    throw new Error(`GraphQL error: ${payload.errors.map((error) => error.message).join("; ")}`);
  }

  return payload.data;
}

async function parseJsonResponse(response) {
  const text = await response.text();
  let payload;

  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Expected JSON response but received: ${text.slice(0, 200)}`);
  }

  if (!response.ok) {
    const errorMessage =
      payload?.error?.message ||
      payload?.error ||
      payload?.message ||
      text ||
      `${response.status} ${response.statusText}`;
    throw new Error(errorMessage);
  }

  return payload;
}

await main();
