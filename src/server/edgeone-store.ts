import { createHash } from "node:crypto";
import type { EvidenceStore } from "./evidence.js";
import { MemoryRepository, type Database } from "./repository.js";

export type ConversationStore = {
  getConversation(args: { conversationId: string }): Promise<{ metadata?: Record<string, unknown> }>;
  updateConversation(args: { conversationId: string; metadata: Record<string, unknown> }): Promise<unknown>;
  appendMessage(args: { conversationId: string; role: string; content: unknown; metadata?: Record<string, unknown> }): Promise<string>;
  getMessages?(args: { conversationId: string; limit?: number; order?: "asc" | "desc"; after?: string }): Promise<Array<{ messageId: string; metadata?: Record<string, unknown> }>>;
  deleteMessage?(args: { conversationId: string; messageId: string }): Promise<unknown>;
};

export class ConversationRepository extends MemoryRepository {
  private constructor(private readonly store: ConversationStore, private readonly conversationId: string, seed?: Partial<Database>) {
    super(seed);
  }
  static async open(store: ConversationStore, conversationId: string) {
    let metadata: Record<string, unknown> = {};
    try { metadata = (await store.getConversation({ conversationId })).metadata ?? {}; }
    catch {
      await store.appendMessage({ conversationId, role: "system", content: "Ratings collector state", metadata: { kind: "ratings-init" } });
    }
    const database = metadata.ratingsDatabase as Partial<Database> | undefined;
    return new ConversationRepository(store, conversationId, database);
  }
  protected override async changed(): Promise<void> {
    await this.store.updateConversation({ conversationId: this.conversationId, metadata: { ratingsDatabase: structuredClone(this.db) } });
  }
}

export class ConversationEvidenceStore implements EvidenceStore {
  private cleanup?: Promise<void>;
  constructor(private readonly store: ConversationStore, private readonly conversationId: string) {}
  async put(payload: unknown): Promise<string> {
    this.cleanup ??= this.cleanupExpired();
    await this.cleanup;
    const digest = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
    const messageId = await this.store.appendMessage({
      conversationId: this.conversationId, role: "tool", content: payload,
      metadata: { kind: "ratings-evidence", digest, expiresAt }
    });
    return `conversation:${this.conversationId}:${messageId}`;
  }

  private async cleanupExpired(): Promise<void> {
    if (!this.store.getMessages || !this.store.deleteMessage) return;
    let after: string | undefined;
    for (;;) {
      const messages = await this.store.getMessages({ conversationId: this.conversationId, limit: 100, order: "asc", after });
      for (const message of messages) {
        const expiresAt = message.metadata?.expiresAt;
        if (message.metadata?.kind === "ratings-evidence" && typeof expiresAt === "string" && Date.parse(expiresAt) <= Date.now()) {
          await this.store.deleteMessage({ conversationId: this.conversationId, messageId: message.messageId });
        }
      }
      if (messages.length < 100) return;
      after = messages.at(-1)?.messageId;
      if (!after) return;
    }
  }
}
