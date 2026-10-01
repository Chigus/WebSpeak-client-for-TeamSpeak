import { avatarDataUrl } from "./directory-view.js";
import type { TSClientAvatar } from "./ts-client.js";

interface AvatarMember {
  id: number;
  uid: string;
  avatar?: string;
}

export interface MemberAvatarOptions {
  members: ReadonlyMap<number, AvatarMember>;
  cache: Map<string, string | null>;
  isCurrent(): boolean;
  load(id: number, uid: string): Promise<TSClientAvatar | null>;
  publish(id: number, uid: string, avatar: string): void;
  onError(id: number, uid: string, error: unknown): void;
}

/** Optional SDK downloads belong to one connected directory generation. */
export class MemberAvatarLoader {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private batch: symbol | null = null;
  private closed = false;

  constructor(private readonly options: MemberAvatarOptions) {}

  private isCurrent(): boolean {
    return !this.closed && this.options.isCurrent();
  }

  private pendingMembers(): AvatarMember[] {
    const byUid = new Map<string, AvatarMember>();
    for (const member of this.options.members.values()) {
      if (member.uid && !this.options.cache.has(member.uid)) byUid.set(member.uid, member);
    }
    return [...byUid.values()];
  }

  schedule(delayMs = 0): void {
    if (!this.isCurrent() || this.timer !== null || this.batch !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh();
    }, delayMs);
    this.timer.unref?.();
  }

  private async refresh(): Promise<void> {
    if (!this.isCurrent() || this.batch !== null) return;
    const batch = Symbol("avatar batch");
    this.batch = batch;
    const isCurrent = () => this.batch === batch && this.isCurrent();
    try {
      // Keep SDK file transfers sequential and retain the existing batch limit.
      for (const member of this.pendingMembers().slice(0, 50)) {
        if (!isCurrent()) return;
        if (this.options.members.get(member.id)?.uid !== member.uid) continue;
        try {
          const loaded = await this.options.load(member.id, member.uid);
          if (!isCurrent()) return;
          const current = this.options.members.get(member.id);
          if (current?.uid !== member.uid) continue;
          const avatar = loaded ? avatarDataUrl(loaded.data) : null;
          this.options.cache.set(member.uid, avatar);
          if (avatar) {
            for (const candidate of this.options.members.values()) {
              if (candidate.uid !== member.uid) continue;
              candidate.avatar = avatar;
              this.options.publish(candidate.id, candidate.uid, avatar);
            }
          }
        } catch (error: unknown) {
          if (!isCurrent()) return;
          if (this.options.members.get(member.id)?.uid !== member.uid) continue;
          // Permission and file-transfer failures are optional, not join errors.
          this.options.cache.set(member.uid, null);
          this.options.onError(member.id, member.uid, error);
        }
      }
    } finally {
      // A late old batch must not clear a newer generation's running work.
      if (this.batch === batch) {
        this.batch = null;
        if (this.isCurrent() && this.pendingMembers().length) this.schedule(250);
      }
    }
  }

  reset(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.batch = null;
    this.options.cache.clear();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.reset();
  }
}
