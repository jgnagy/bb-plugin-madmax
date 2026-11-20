// bb-plugin-madmax — first-run onboarding: choose where the town lives.
import { useCallback, useEffect, useState } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";

import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import type { rpcContract } from "../server";

type TownProjectChoice = { projectId: string; name: string; kind: string };

type DirectoryBrowse = {
  hostId: string;
  directory: string;
  parent: string | null;
  roots: string[];
  directories: { name: string; path: string }[];
};

/** Folder picker dialog backed by hosts.directory on the connected host. */
function FolderBrowser({
  open,
  onOpenChange,
  onChoose,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChoose: (path: string) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [listing, setListing] = useState<DirectoryBrowse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    (path?: string) => {
      setListing(null);
      setError(null);
      rpc
        .call("browseTownDirectories", path ? { path } : {})
        .then(setListing, (cause: unknown) =>
          setError(cause instanceof Error ? cause.message : String(cause)),
        );
    },
    [rpc],
  );

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Choose a town folder</DialogTitle>
          <DialogDescription>
            Pick where the town lives on disk. The folder is created if it
            doesn't exist yet.
          </DialogDescription>
        </DialogHeader>
        {error !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {listing === null ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {error === null ? "Loading folders…" : ""}
          </p>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <code
                className="min-w-0 flex-1 truncate rounded-md border border-border bg-muted px-2 py-1.5 font-mono text-xs"
                title={listing.directory}
              >
                {listing.directory}
              </code>
              <Button
                variant="outline"
                size="icon"
                aria-label="Go to home folder"
                onClick={() => load()}
              >
                <Icon name="House" className="size-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                aria-label="Go to parent folder"
                disabled={listing.parent === null}
                onClick={() => load(listing.parent ?? undefined)}
              >
                <Icon name="ArrowUp" className="size-4" />
              </Button>
            </div>
            <ul className="max-h-64 space-y-1 overflow-y-auto rounded-md border border-border p-1">
              {listing.directories.length === 0 ? (
                <li className="px-2 py-1.5 text-sm text-muted-foreground">
                  No subfolders here.
                </li>
              ) : (
                listing.directories.map((entry) => (
                  <li key={entry.path}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      onClick={() => load(entry.path)}
                    >
                      <Icon name="Folder" className="size-4 shrink-0 text-muted-foreground" />
                      <span className="truncate">{entry.name}</span>
                    </button>
                  </li>
                ))
              )}
            </ul>
          </div>
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button
            disabled={listing === null}
            onClick={() => {
              if (listing !== null) {
                onChoose(listing.directory);
                onOpenChange(false);
              }
            }}
          >
            <Icon name="Check" className="size-4" />
            Use this folder
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** First-run chooser: where should the town live? */
export function TownOnboarding() {
  const navigate = useBbNavigate();
  const rpc = useRpc<typeof rpcContract>();
  const [projects, setProjects] = useState<TownProjectChoice[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [browseOpen, setBrowseOpen] = useState(false);

  const report = useCallback((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : String(cause));
    setBusy(null);
  }, []);

  useEffect(() => {
    rpc.call("projectsList", null).then((result) => setProjects(result.projects), report);
  }, [rpc, report]);

  const choose = useCallback(async (projectId: string) => {
    if (busy !== null) return;
    setBusy(projectId);
    setError(null);
    try {
      const result = await rpc.call("chooseTown", { projectId });
      navigate.toThread(result.threadId);
    } catch (cause) {
      report(cause);
    }
  }, [busy, navigate, rpc, report]);

  const create = useCallback(async () => {
    if (busy !== null || name.trim() === "" || path.trim() === "") return;
    setBusy("new-town");
    setError(null);
    try {
      const result = await rpc.call("createTown", { name: name.trim(), path: path.trim() });
      navigate.toThread(result.threadId);
    } catch (cause) {
      report(cause);
    }
  }, [busy, name, navigate, path, rpc, report]);

  return (
    <div className="rounded-lg border border-border bg-card text-card-foreground">
      <div className="space-y-3 px-6 py-4 text-sm">
        <p className="text-foreground">
          Welcome to your town. Pick an existing project to import a town that
          already lives there — or create a dedicated folder below, which is
          how most towns start (it gets a git repo, a Beads ledger, and a
          rules starter).
        </p>
        {error !== null ? (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        ) : null}
        {projects === null ? (
          <p className="text-muted-foreground">Loading your projects…</p>
        ) : projects.length === 0 ? (
          <p className="text-muted-foreground">
            No bb projects to import — start your town with a new folder below.
          </p>
        ) : (
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">
              Import a town from an existing bb project:
            </p>
            <ul className="flex flex-wrap gap-2">
              {projects.map((project) => (
                <li key={project.projectId}>
                  <Button
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => void choose(project.projectId)}
                  >
                    {busy === project.projectId ? "Starting…" : project.name}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="space-y-2 border-t border-border pt-3">
          <p className="text-sm text-muted-foreground">
            Or a new town folder (created if missing):
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Town name"
              aria-label="New town name"
              className="w-40"
            />
            <Input
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder="/path/to/town"
              aria-label="New town folder path"
              className="min-w-56 flex-1"
            />
            <Button
              variant="outline"
              size="icon"
              aria-label="Browse folders"
              disabled={busy !== null}
              onClick={() => setBrowseOpen(true)}
            >
              <Icon name="FolderOpen" className="size-4" />
            </Button>
          </div>
          <Button
            variant="outline"
            disabled={busy !== null || name.trim() === "" || path.trim() === ""}
            onClick={() => void create()}
          >
            <Icon name="Plus" className="size-4" />
            {busy === "new-town" ? "Creating…" : "Create town"}
          </Button>
        </div>
        <FolderBrowser
          open={browseOpen}
          onOpenChange={setBrowseOpen}
          onChoose={(chosen) => setPath(chosen)}
        />
      </div>
    </div>
  );
}
