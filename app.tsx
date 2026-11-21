// bb-plugin-madmax — the town frontend.
//
// A "Start Mayor" launcher on bb's New Thread screen with a live town summary
// (problems first), a Town Hall dashboard, a role badge on managed threads'
// sidebar rows, and the controls (steer / interrupt / end) on each
// worker's card. The pieces live in app/; this file only wires the slots.
import { definePluginApp } from "@get-bb/plugin-sdk/app";

import { TownHallPage } from "./app/board";
import { TownRowBadge, useTownRoles } from "./app/row-badge";
import { TownSection } from "./app/section";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "town-hall",
    title: "Town Hall",
    icon: "Landmark",
    path: "town-hall",
    component: TownHallPage,
  });
  app.slots.homepageSection({
    id: "madmax-town",
    title: "Madmax",
    component: TownSection,
  });
  app.slots.experimental_threadRowMetadata({
    id: "madmax-role",
    order: 10,
    useData: () => useTownRoles(),
    component: TownRowBadge,
  });
});
