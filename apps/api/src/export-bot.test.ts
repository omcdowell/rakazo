import type { AdapterContext, AgentHomeStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { buildBotExportManifest, type ExportLimits, ExportTooLargeError } from "./export-bot.js";

const limits: ExportLimits = {
  maxTotalBytes: 20,
  maxFileCount: 1,
  maxFileBytes: 8,
  maxMessageCount: 1,
};

const exportContext: AdapterContext = {
  operationId: "export",
  traceId: "export",
  workspaceId: "workspace-1",
  userId: "user-1",
  signal: new AbortController().signal,
};

function fakeHome(files: Array<{ path: string; content: string }>): AgentHomeStore {
  return {
    async *exportHome(
      _botId: string,
      _context: AdapterContext,
      options?: { maxFileBytes?: number },
    ) {
      for (const file of files) {
        const content = new TextEncoder().encode(file.content);
        if (options?.maxFileBytes !== undefined && content.byteLength > options.maxFileBytes) {
          throw new Error(`agent home file exceeds ${options.maxFileBytes} bytes`);
        }
        yield { path: file.path, content };
      }
    },
  } as AgentHomeStore;
}

function prismaStub(options?: { messageCount?: number; messages?: unknown[] }) {
  const count = vi.fn(async () => options?.messageCount ?? 0);
  const findMany = vi.fn(async () => options?.messages ?? []);
  return {
    count,
    findMany,
    prisma: {
      memoryDocument: { findMany: vi.fn(async () => []) },
      routine: { findMany: vi.fn(async () => []) },
      message: { count, findMany },
    } as unknown as PrismaClient,
  };
}

const bot = {
  name: "Chief",
  title: "",
  description: "",
  instructions: "",
};

describe("buildBotExportManifest", () => {
  it("rejects an oversized home without paging thread history", async () => {
    const { count, findMany, prisma } = prismaStub();

    await expect(
      buildBotExportManifest({
        bot,
        botId: "bot-1",
        threadId: "thread-1",
        workspaceId: "workspace-1",
        homeKey: "home-1",
        home: fakeHome([
          { path: "a.txt", content: "aa" },
          { path: "b.txt", content: "bb" },
        ]),
        prisma,
        exportContext,
        limits,
      }),
    ).rejects.toMatchObject({ name: "ExportTooLargeError", limit: "fileCount" });

    expect(count).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
  });

  it("rejects a single home file over the per-file byte cap", async () => {
    await expect(
      buildBotExportManifest({
        bot,
        botId: "bot-1",
        threadId: "thread-1",
        workspaceId: "workspace-1",
        homeKey: "home-1",
        home: fakeHome([{ path: "large.txt", content: "123456789" }]),
        prisma: prismaStub().prisma,
        exportContext,
        limits,
      }),
    ).rejects.toBeInstanceOf(ExportTooLargeError);
  });

  it("rejects when home files exceed the total byte budget", async () => {
    await expect(
      buildBotExportManifest({
        bot,
        botId: "bot-1",
        threadId: "thread-1",
        workspaceId: "workspace-1",
        homeKey: "home-1",
        home: fakeHome([{ path: "a.txt", content: "123456789012345678901" }]),
        prisma: prismaStub().prisma,
        exportContext,
        limits: { ...limits, maxFileBytes: 32, maxFileCount: 10 },
      }),
    ).rejects.toMatchObject({ limit: "totalBytes" });
  });

  it("rejects history over the message cap without loading pages", async () => {
    const { count, findMany, prisma } = prismaStub({ messageCount: 2 });

    await expect(
      buildBotExportManifest({
        bot,
        botId: "bot-1",
        threadId: "thread-1",
        workspaceId: "workspace-1",
        homeKey: "home-1",
        home: fakeHome([]),
        prisma,
        exportContext,
        limits,
      }),
    ).rejects.toMatchObject({ limit: "messageCount" });

    expect(count).toHaveBeenCalledWith({ where: { threadId: "thread-1" } });
    expect(findMany).not.toHaveBeenCalled();
  });

  it("returns a JSON manifest for a home and history inside the limits", async () => {
    const { prisma } = prismaStub({
      messages: [
        {
          id: "message-0",
          threadId: "thread-1",
          seq: 0,
          role: "user",
          blocks: [],
          botId: null,
          replyToMessageId: null,
          runId: null,
          createdAt: new Date("2026-08-16T00:00:00.000Z"),
        },
      ],
    });

    const manifest = await buildBotExportManifest({
      bot,
      botId: "bot-1",
      threadId: "thread-1",
      workspaceId: "workspace-1",
      homeKey: "home-1",
      home: fakeHome([{ path: "note.txt", content: "hi" }]),
      prisma,
      exportContext,
      limits: { ...limits, maxTotalBytes: 1024, maxFileBytes: 1024 },
      now: new Date("2026-08-29T00:00:00.000Z"),
    });

    expect(manifest).toEqual({
      version: 1,
      exportedAt: "2026-08-29T00:00:00.000Z",
      bot,
      memory: [],
      routines: [],
      files: [{ path: "note.txt", content: "hi" }],
      history: [
        {
          id: "message-0",
          threadId: "thread-1",
          seq: 0,
          role: "user",
          blocks: [],
          botId: undefined,
          replyToMessageId: undefined,
          runId: undefined,
          createdAt: "2026-08-16T00:00:00.000Z",
        },
      ],
    });
  });
});
