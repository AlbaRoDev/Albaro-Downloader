import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

// shadcn/ui's class helper: joins classes and lets a later Tailwind class override an earlier
// conflicting one (`cn("px-2", "px-4")` is "px-4").
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
