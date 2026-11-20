// bb-plugin-madmax — the controls on a worker's card: steer it,
// interrupt its running turn, or end it. Each calls a town_* RPC that acts on
// the managed thread directly. End asks first when the worker still has open work.
import { useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Textarea } from "@/components/ui/textarea";
import type { rpcContract } from "../server";

/**
 * A draft kept in the browser's localStorage, keyed by thread. It outlives the
 * control's mount, so words typed then switched away are still there — written
 * on every change, not on blur. Storage unavailable (e.g. a sandboxed context)
 * falls back to in-memory only.
 */
function useDraft(key: string): [string, (next: string) => void] {
  const [value, setValue] = useState(() => {
    try {
      return window.localStorage.getItem(key) ?? "";
    } catch {
      return "";
    }
  });
  const set = (next: string): void => {
    setValue(next);
    try {
      if (next === "") window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, next);
    } catch {
      /* storage unavailable — the draft lives in memory only */
    }
  };
  return [value, set];
}

/**
 * One worker's controls. Steer queues a message behind the worker's current
 * turn, or — with the box checked — steers the running turn in place. Interrupt
 * stops the turn. End archives the worker; the server asks to confirm when the
 * worker still has open work, so nothing live is dropped on a first press. A
 * Note leaves words for the Mayor about this worker, from a draft that persists.
 */
export function WorkerControls({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [busy, setBusy] = useState(false);
  const [steerOpen, setSteerOpen] = useState(false);
  const [steerText, setSteerText] = useState("");
  const [steerNow, setSteerNow] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteText, setNoteText] = useDraft(`madmax-note:${threadId}`);
  const [confirmEnd, setConfirmEnd] = useState(false);

  async function run(action: () => Promise<unknown>, success: string): Promise<void> {
    setBusy(true);
    try {
      await action();
      toast.success(success);
      setSteerOpen(false);
      setSteerText("");
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  function steer(): void {
    const text = steerText.trim();
    if (!text || busy) return;
    void run(() => rpc.call("townNudge", { threadId, text, steer: steerNow }), steerNow ? "Steering the turn." : "Queued behind its work.");
  }

  function interrupt(): void {
    void run(() => rpc.call("townInterrupt", { threadId }), "Interrupted.");
  }

  function note(): void {
    const text = noteText.trim();
    if (!text || busy) return;
    setBusy(true);
    rpc
      .call("townNote", { threadId, text })
      .then(() => {
        toast.success("Note sent to the Mayor.");
        setNoteOpen(false);
        setNoteText("");
      })
      .catch((cause) => toast.error(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  }

  function end(confirmed: boolean): void {
    if (busy) return;
    setBusy(true);
    rpc
      .call("townEnd", { threadId, confirmed })
      .then((result) => {
        if (result.needsConfirmation) {
          setConfirmEnd(true);
          return;
        }
        if (result.ended) {
          toast.success("Worker ended.");
          setConfirmEnd(false);
        }
      })
      .catch((cause) => toast.error(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  }

  return (
    <div className="flex flex-col gap-1.5 pt-1">
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => setSteerOpen((open) => !open)}>
          <Icon name="Pencil" className="size-3" /> Steer
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={interrupt}>
          <Icon name="Stop" className="size-3" /> Interrupt
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => setNoteOpen((open) => !open)}>
          <Icon name="MessageSquare" className="size-3" /> Note
        </Button>
        <Button size="sm" variant="outline" className="text-destructive" disabled={busy} onClick={() => end(false)}>
          <Icon name="Archive" className="size-3" /> End
        </Button>
      </div>
      {steerOpen ? (
        <div className="flex flex-col gap-1.5">
          <Textarea
            value={steerText}
            onChange={(event) => setSteerText(event.target.value)}
            placeholder={steerNow ? "Steer the running turn…" : "Tell the worker something…"}
            className="max-h-40 min-h-7 resize-none"
          />
          <div className="flex items-center gap-3">
            <label className="flex cursor-pointer items-center gap-1 text-xs text-muted-foreground">
              <input type="checkbox" checked={steerNow} onChange={(event) => setSteerNow(event.target.checked)} />
              Interrupt its running turn
            </label>
            <div className="ml-auto flex gap-1.5">
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setSteerOpen(false)}>
                Cancel
              </Button>
              <Button size="sm" disabled={busy || !steerText.trim()} onClick={steer}>
                Send
              </Button>
            </div>
          </div>
        </div>
      ) : null}
      {noteOpen ? (
        <div className="flex flex-col gap-1.5">
          <Textarea
            value={noteText}
            onChange={(event) => setNoteText(event.target.value)}
            placeholder="A note for the Mayor about this worker…"
            className="max-h-40 min-h-7 resize-none"
          />
          <div className="flex justify-end gap-1.5">
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setNoteOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" disabled={busy || !noteText.trim()} onClick={note}>
              Send
            </Button>
          </div>
        </div>
      ) : null}
      <ConfirmEnd open={confirmEnd} onOpenChange={setConfirmEnd} onConfirm={() => end(true)} onDeny={() => setConfirmEnd(false)} />
    </div>
  );
}

function ConfirmEnd({
  open,
  onOpenChange,
  onConfirm,
  onDeny,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  onDeny: () => void;
}) {
  return (
    <div className={open ? "block" : "hidden"}>
      <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs">
        <p className="mb-2 text-destructive">
          Ending archives this worker and its worktree. Any uncommitted work is lost — only committed
          work survives. Continue?
        </p>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onDeny}>
            Keep it
          </Button>
          <Button size="sm" variant="destructive" onClick={onConfirm}>
            End it
          </Button>
        </div>
      </div>
    </div>
  );
}
