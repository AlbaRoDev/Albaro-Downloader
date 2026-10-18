// The downloads' store: Zustand around the pure reducer of `downloadsState.ts`
// (which does not change). It holds the map of downloads, the notices of refused actions and
// the card's choice; it is fed only by `list_downloads` and the queue's events, through
// `startDownloadsStore`. It also mirrors the saved output folder and file name:
// the backend owns them, and this is only what was last read or written. Components read it with selectors, so a row sees only its own entry.
import { create } from "zustand";
import { getSettings } from "@/features/settings/settings";
import {
  asAppError,
  type Browser,
  cancelDownload,
  type DownloadSettings,
  dismissDownload,
  dismissEndedDownloads,
  type ErrorCode,
  getDownloadSettings,
  getOutputSettings,
  isBackendAvailable,
  listDownloads,
  type NameTemplate,
  type OutputSettings,
  onDownloadFinished,
  onDownloadProgress,
  onDownloadRetrying,
  onDownloadState,
  pauseDownload,
  pickCookiesFile,
  pickOutputDir,
  resumeDownload,
  retryDownload,
  retryInOtherFolder,
  revealDownload,
  setCookiesBrowser,
  setLimitRate,
  setMaxConcurrent,
  setNameTemplate,
  setNotifications,
} from "@/lib/ipc";
import {
  type Action,
  type DownloadsState,
  EMPTY,
  isKnown,
  reduce,
} from "./downloadsState";
import { type Choice, choiceFrom } from "./options";

// Why a row's last action failed: the backend's error, or "revealFailed" (the file could not be
// shown), with the technical message (empty for "revealFailed": whatever the cause, the text
// says the file is gone). Cleared by the row's next action.
export interface Notice {
  code: ErrorCode | "revealFailed";
  message: string;
}

interface DownloadsStore {
  downloads: DownloadsState;
  notices: Record<number, Notice>;
  // The card's choice: kept here so it survives going from one link to the next.
  choice: Choice;
  // The saved output folder (null until the first read) and file name, as the backend has them.
  outputDir: string | null;
  nameTemplate: NameTemplate;
  // The folder is too deep for titles to fit in a path.
  folderTooDeep: boolean;
  // Why the last attempt to pick a folder, or to change the name, was refused (null: it was not).
  folderProblem: ErrorCode | null;
  nameProblem: ErrorCode | null;
  // The limits and the cookies browser, null until the first read, and why the
  // last change was refused. `settingsOpen` is the gear's panel: a failed row can open it.
  settings: DownloadSettings | null;
  settingsProblem: ErrorCode | null;
  settingsOpen: boolean;
  dispatch: (action: Action) => void;
  setNotice: (id: number, notice: Notice | null) => void;
  setChoice: (choice: Choice) => void;
}

const INITIAL_OUTPUT = {
  outputDir: null,
  nameTemplate: "titleId",
  folderTooDeep: false,
  folderProblem: null,
  nameProblem: null,
  settings: null,
  settingsProblem: null,
  settingsOpen: false,
} as const;

// The card's starting choice: the built-in one with the user's defaults.
const initialChoice = () => choiceFrom(getSettings());

export const useDownloadsStore = create<DownloadsStore>()((set) => ({
  downloads: EMPTY,
  notices: {},
  choice: initialChoice(),
  ...INITIAL_OUTPUT,
  dispatch: (action) =>
    set((store) => ({ downloads: reduce(store.downloads, action) })),
  setNotice: (id, notice) =>
    set((store) => {
      const { [id]: _old, ...rest } = store.notices;
      return { notices: notice ? { ...rest, [id]: notice } : rest };
    }),
  setChoice: (choice) => set({ choice }),
}));

// Back to an empty store. For tests.
export function resetDownloadsStore() {
  useDownloadsStore.setState({
    downloads: EMPTY,
    notices: {},
    choice: initialChoice(),
    ...INITIAL_OUTPUT,
  });
}

const dispatch = (action: Action) =>
  useDownloadsStore.getState().dispatch(action);

// The reader of one subscription: reads the list again and makes it the truth about which rows
// exist (what only events know, the progress, stays). `alive` says whether the subscription is
// still running. A batch of 300 new rows sends 300
// `download-state` events for ids the store does not know: one read at a time, and every request
// made while it runs becomes a single read after it (which sees everything queued by then). The
// bookkeeping is per subscription, so a read that never answers cannot block a later one.
function reloader(alive: () => boolean): () => void {
  let reading = false;
  let again = false;
  const reload = () => {
    if (reading) {
      again = true;
      return;
    }
    reading = true;
    listDownloads()
      .then(
        // A browser test double may answer with anything: only a list counts.
        (downloads) => {
          if (alive() && Array.isArray(downloads)) {
            dispatch({ type: "loaded", downloads });
          }
        },
        console.error,
      )
      .finally(() => {
        reading = false;
        if (again) {
          again = false;
          reload();
        }
      });
  };
  return reload;
}

// The saved folder and name. `alive` as in `reload`; anything but the settings is ignored.
function loadOutput(alive: () => boolean) {
  getOutputSettings().then((output: OutputSettings | null) => {
    if (alive() && typeof output?.outputDir === "string") {
      useDownloadsStore.setState({
        outputDir: output.outputDir,
        nameTemplate: output.nameTemplate,
        folderTooDeep: output.folderTooDeep === true,
      });
    }
  }, console.error);
}

// The limits and the cookies browser. `alive` as in `reload`.
function loadSettings(alive: () => boolean) {
  getDownloadSettings().then((settings: DownloadSettings | null) => {
    if (alive() && typeof settings?.maxConcurrent === "number") {
      useDownloadsStore.setState({ settings });
    }
  }, console.error);
}

interface Subscription {
  users: number;
  stop: () => void;
}

let subscription: Subscription | null = null;

function subscribe(): Subscription {
  // Each subscription has its own flag: events that reach a handler after `stop` (its
  // `unlisten` is asynchronous) are ignored, so a restarted one never double-counts them.
  let active = true;
  const alive = () => active;
  const reload = reloader(alive);
  reload();
  loadOutput(alive);
  loadSettings(alive);
  const unlisten = Promise.all([
    onDownloadState((event) => {
      if (!active) return;
      if (isKnown(useDownloadsStore.getState().downloads, event.id)) {
        dispatch({ type: "state", event, now: Date.now() });
      } else reload(); // queued from the card, or by another window
    }),
    onDownloadProgress(({ id, progress }) => {
      if (active) dispatch({ type: "progress", id, progress, now: Date.now() });
    }),
    onDownloadRetrying((event) => {
      if (active) dispatch({ type: "retrying", event });
    }),
    onDownloadFinished(({ id }) => {
      if (active) dispatch({ type: "finished", id });
    }),
  ]);
  return {
    users: 1,
    stop() {
      active = false;
      unlisten.then((fns) => {
        // Unlistening fails (a rejected promise) only where there is no real event system
        // behind it, a test double: nothing to do about it on the way out.
        for (const fn of fns) {
          Promise.resolve()
            .then(fn)
            .catch(() => {});
        }
      });
    },
  };
}

// Loads `list_downloads` and follows the queue's events. The queue recovers downloads at
// startup without sending events, which is why the list is read first. One subscription however
// many callers (React's StrictMode mounts, unmounts and mounts again): the first call starts
// it, the last stop ends it. Returns the stop function. Does nothing without a backend (a plain
// browser or a test).
export function startDownloadsStore(): () => void {
  if (!isBackendAvailable()) return () => {};
  if (subscription) subscription.users++;
  else subscription = subscribe();
  const mine = subscription;
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    if (--mine.users === 0) {
      mine.stop();
      if (subscription === mine) subscription = null;
    }
  };
}

// Runs a command for row `id`. The queue's events change the row; this only reports a refusal
// (a state that moved on in the meantime, a file that is gone).
function run(
  id: number,
  action: () => Promise<unknown>,
  onError?: () => Notice,
): void {
  const { setNotice } = useDownloadsStore.getState();
  setNotice(id, null);
  action().then(
    () => undefined,
    (error) => setNotice(id, onError ? onError() : asAppError(error)),
  );
}

export interface DownloadActions {
  pause: (id: number) => void;
  resume: (id: number) => void;
  cancel: (id: number) => void;
  retry: (id: number) => void;
  // Picks a folder (native dialog), moves the failed download there and retries it.
  retryElsewhere: (id: number) => void;
  reveal: (id: number) => void;
  dismiss: (id: number) => void;
  // Opens the gear's panel, for the errors that the settings fix.
  openSettings: () => void;
}

// Module constants: the same object forever, so rows (memoized) never re-render because of it.
// The folder the backend now has, and whether it is too deep.
const showFolder = (output: OutputSettings) =>
  useDownloadsStore.setState({
    outputDir: output.outputDir,
    folderTooDeep: output.folderTooDeep === true,
  });

export const downloadActions: DownloadActions = {
  pause: (id) => run(id, () => pauseDownload(id)),
  resume: (id) => run(id, () => resumeDownload(id)),
  cancel: (id) => run(id, () => cancelDownload(id)),
  retry: (id) => run(id, () => retryDownload(id)),
  // The row changes through the queue's events; the picked folder is also the new default one,
  // which the top bar's button shows. Cancelling the picker resolves with the same folder.
  retryElsewhere: (id) =>
    run(id, () => retryInOtherFolder(id).then(showFolder)),
  reveal: (id) =>
    run(
      id,
      () => revealDownload(id),
      () => ({ code: "revealFailed", message: "" }),
    ),
  // The row goes once the backend has hidden it; the file is not touched.
  dismiss: (id) =>
    run(id, () =>
      dismissDownload(id).then(() => dispatch({ type: "dismissed", id })),
    ),
  openSettings: () => settingsActions.setOpen(true),
};

// "Clear the list" (not a row's action): the backend hides what has ended and the list drops it
// once it says so. A refusal only leaves the list as it was; there is no row to hang a notice on.
export function clearEnded(): void {
  dismissEndedDownloads().then(
    () => dispatch({ type: "dismissedEnded" }),
    (error) => console.error("clear the list:", error),
  );
}

// The output folder and file name. Both are saved by the backend; these only report
// what it said.
export const outputActions = {
  // Opens the native folder picker and waits for the user. Cancelling changes nothing; a folder
  // that cannot be used leaves the old one and sets `folderProblem`.
  async pickFolder() {
    useDownloadsStore.setState({ folderProblem: null });
    try {
      showFolder(await pickOutputDir());
    } catch (error) {
      useDownloadsStore.setState({ folderProblem: asAppError(error).code });
    }
  },
  dismissFolderProblem() {
    useDownloadsStore.setState({ folderProblem: null });
  },
  // Shows the new name at once and saves it; if the backend refuses, goes back to the old one.
  async changeName(template: NameTemplate) {
    const previous = useDownloadsStore.getState().nameTemplate;
    useDownloadsStore.setState({ nameTemplate: template, nameProblem: null });
    try {
      await setNameTemplate(template);
    } catch (error) {
      useDownloadsStore.setState({
        nameTemplate: previous,
        nameProblem: asAppError(error).code,
      });
    }
  },
};

// The limits and the cookies browser. Each change shows at once and is saved
// by the backend; if it refuses, the old value comes back and `settingsProblem` says why.
export const settingsActions = {
  setOpen(open: boolean) {
    useDownloadsStore.setState({ settingsOpen: open });
  },
  setMaxConcurrent: (max: number) =>
    change({ maxConcurrent: max }, () => setMaxConcurrent(max)),
  setNotifications: (on: boolean) =>
    change({ notifications: on }, () => setNotifications(on)),
  setLimitRate: (kbps: number | null) =>
    change({ limitRateKbps: kbps }, () => setLimitRate(kbps)),
  // A browser, or none, drops the cookies file: there is one source at a time (as in the backend).
  setCookiesBrowser: (browser: Browser | null) =>
    change({ cookiesBrowser: browser, cookiesFile: null }, () =>
      setCookiesBrowser(browser),
    ),
  // Opens the native file picker and waits for the user. Cancelling changes nothing; a file that
  // cannot be used leaves the old source and sets `settingsProblem`.
  async pickCookiesFile() {
    useDownloadsStore.setState({ settingsProblem: null });
    try {
      useDownloadsStore.setState({ settings: await pickCookiesFile() });
    } catch (error) {
      useDownloadsStore.setState({
        settingsProblem: asAppError(error).code,
      });
    }
  },
};

async function change(
  patch: Partial<DownloadSettings>,
  save: () => Promise<void>,
) {
  const previous = useDownloadsStore.getState().settings;
  // Not read yet: nothing to show or to go back to, and the controls are disabled anyway.
  if (!previous) return;
  useDownloadsStore.setState({
    settings: { ...previous, ...patch },
    settingsProblem: null,
  });
  try {
    await save();
  } catch (error) {
    // Only the field that failed goes back: another change may have landed meanwhile.
    const current = useDownloadsStore.getState().settings;
    const reverted = Object.fromEntries(
      Object.keys(patch).map((key) => [
        key,
        previous[key as keyof DownloadSettings],
      ]),
    );
    useDownloadsStore.setState({
      settings: current && { ...current, ...reverted },
      settingsProblem: asAppError(error).code,
    });
  }
}
