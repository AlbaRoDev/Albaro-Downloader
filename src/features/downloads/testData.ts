// Made-up downloads and progress updates for the tests of the list.
import type { Download, Progress } from "@/lib/ipc";

export const download = (
  id: number,
  patch: Partial<Download> = {},
): Download => ({
  id,
  request: {
    url: `https://example.test/${id}`,
    mode: { kind: "video", maxHeight: null, container: "mp4" },
  },
  title: `Title ${id}`,
  thumbnail: null,
  state: "pending",
  error: null,
  createdAt: 1,
  updatedAt: 1,
  batch: null,
  ...patch,
});

export const progress = (patch: Partial<Progress> = {}): Progress => ({
  status: "downloading",
  downloadedBytes: 50,
  totalBytes: 100,
  speed: 1024,
  eta: 5,
  filename: "a.f1.mp4",
  fragmentIndex: null,
  fragmentCount: null,
  ...patch,
});
