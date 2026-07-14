export type DockEdge = "left" | "right" | "top";
export type DockUiMode = "none" | "hidden" | "peek";

export interface DockUiState {
  mode: DockUiMode;
  edge: DockEdge | null;
}

export type DockEvent =
  | { kind: "dockCheckResult"; edge: DockEdge | null }
  | { kind: "pointerEnter" }
  | { kind: "pointerLeaveSettled" }
  | { kind: "dockDisabled" }
  | { kind: "restored"; state: { edge: DockEdge } | null };

export type DockCommand =
  | { kind: "setMode"; mode: "hidden" | "peek" }
  | { kind: "undock" }
  | { kind: "closePanel" };

const noneState: DockUiState = { mode: "none", edge: null };

export function reduceDock(
  state: DockUiState,
  event: DockEvent,
): { state: DockUiState; commands: DockCommand[] } {
  switch (event.kind) {
    case "dockCheckResult":
      if (event.edge) {
        return {
          state: { mode: "hidden", edge: event.edge },
          commands: [{ kind: "closePanel" }, { kind: "setMode", mode: "hidden" }],
        };
      }
      if (state.mode !== "none") {
        return { state: noneState, commands: [{ kind: "undock" }] };
      }
      return { state: noneState, commands: [] };
    case "pointerEnter":
      if (state.mode === "hidden" && state.edge) {
        return {
          state: { mode: "peek", edge: state.edge },
          commands: [{ kind: "setMode", mode: "peek" }],
        };
      }
      return { state, commands: [] };
    case "pointerLeaveSettled":
      if (state.mode === "peek" && state.edge) {
        return {
          state: { mode: "hidden", edge: state.edge },
          commands: [{ kind: "closePanel" }, { kind: "setMode", mode: "hidden" }],
        };
      }
      return { state, commands: [] };
    case "dockDisabled":
      if (state.mode !== "none") {
        return { state: noneState, commands: [{ kind: "undock" }] };
      }
      return { state: noneState, commands: [] };
    case "restored":
      if (event.state) {
        return { state: { mode: "hidden", edge: event.state.edge }, commands: [] };
      }
      return { state: noneState, commands: [] };
  }
}
