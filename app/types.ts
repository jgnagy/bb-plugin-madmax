// bb-plugin-madmax — the shapes the town board draws. These mirror the server's
// rpcContract output; the board reads them, never writes them.

import type { BoardBead, ManagedThread, Rig, TownEvent } from "../server";

/** As the New Thread screen's town summary shows the town. */
export type TownStatus = {
  sectionId: string | null;
  townProjectId: string | null;
  mayor: ManagedThread | null;
  threads: ManagedThread[];
  rigs: Rig[];
  ledger: {
    bdAvailable: boolean;
    initialized: boolean;
    path: string | null;
    open: number;
    inProgress: number;
    ready: number;
    convoys: number;
  } | null;
};

/** One convoy (epic) and its beads, as the board's Town Hall lists it. */
export type TownConvoy = { id: string; title: string; status: string; beads: BoardBead[] };

/** Everything the Town Hall page draws. */
export type TownHallData = {
  status: TownStatus;
  convoys: TownConvoy[];
  looseBeads: BoardBead[];
  events: TownEvent[];
};
