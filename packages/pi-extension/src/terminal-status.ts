type RemoteStatusMode = "connecting" | "reconnecting" | "connected" | "running" | "waiting" | "error";

interface RemoteStatusFrame {
  icon: string;
  label: string;
}

export function formatRemoteTitle(baseTitle: string, frame?: RemoteStatusFrame): string {
  return frame ? `${frame.icon} ${frame.label} | ${baseTitle}` : baseTitle;
}

const CONNECTING_FRAMES = ["○", "◔", "◑", "◕"] as const;
const RUNNING_FRAMES = ["◐", "◓", "◑", "◒"] as const;

export function remoteStatusFrame(mode: RemoteStatusMode, frame: number): RemoteStatusFrame {
  const index = Math.abs(frame) % CONNECTING_FRAMES.length;
  switch (mode) {
    case "connecting":
      return { icon: CONNECTING_FRAMES[index]!, label: "connecting" };
    case "reconnecting":
      return { icon: CONNECTING_FRAMES[index]!, label: "reconnecting" };
    case "running":
      return { icon: RUNNING_FRAMES[index]!, label: "active" };
    case "waiting":
      return { icon: "◆", label: "input" };
    case "connected":
      return { icon: "●", label: "connected" };
    case "error":
      return { icon: "!", label: "error" };
  }
}

export class TerminalRemoteIndicator {
  readonly #render: (frame: RemoteStatusFrame | undefined) => void;
  #mode: RemoteStatusMode | undefined;
  #frame = 0;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(render: (frame: RemoteStatusFrame | undefined) => void) {
    this.#render = render;
  }

  set(mode: RemoteStatusMode): void {
    if (this.#mode === mode) return;
    this.#mode = mode;
    this.#frame = 0;
    this.#stopTimer();
    this.#paint();
    if (mode === "connecting" || mode === "reconnecting" || mode === "running") {
      this.#timer = setInterval(() => {
        this.#frame += 1;
        this.#paint();
      }, 320);
      this.#timer.unref?.();
    }
  }

  clear(): void {
    this.#mode = undefined;
    this.#stopTimer();
    this.#render(undefined);
  }

  #paint(): void {
    if (this.#mode) this.#render(remoteStatusFrame(this.#mode, this.#frame));
  }

  #stopTimer(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }
}
