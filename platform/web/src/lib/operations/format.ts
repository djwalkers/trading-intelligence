// Runtime Processes panel — Operations Centre. Pure formatters for PM2 process metrics — every
// value here is already a plain number the API returned; nothing in this file reads the clock,
// the network, or any other I/O.

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

const BYTES_PER_MB = 1024 * 1024;
const MB_PER_GB = 1024;

/** "2h 14m" style — the coarsest two units only (days+hours, or hours+minutes, or minutes alone),
 * never seconds (PM2 uptime is not meaningfully precise to the second for an operator glancing at
 * a dashboard). A negative or sub-minute duration (a clock skew, or a process that only just
 * started) shows "< 1m" rather than "0m" or a negative figure. */
export function formatUptime(uptimeMs: number): string {
  if (!Number.isFinite(uptimeMs) || uptimeMs < MS_PER_MINUTE) return "< 1m";

  const totalMinutes = Math.floor(uptimeMs / MS_PER_MINUTE);
  if (totalMinutes < 60) return `${totalMinutes}m`;

  const totalHours = Math.floor(uptimeMs / MS_PER_HOUR);
  if (totalHours < 24) {
    const minutes = totalMinutes % 60;
    return `${totalHours}h ${minutes}m`;
  }

  const days = Math.floor(uptimeMs / MS_PER_DAY);
  const hours = Math.floor((uptimeMs % MS_PER_DAY) / MS_PER_HOUR);
  return `${days}d ${hours}h`;
}

/** "118 MB" for anything under 1 GB (whole megabytes, rounded); "1.0 GB"/"2.5 GB" once memory
 * reaches a full gigabyte — PM2 reports memory in raw bytes, and a Node/Next.js process routinely
 * sits in the low hundreds of MB, so MB is the primary, always-legible unit. */
export function formatMemoryBytes(bytes: number): string {
  const megabytes = bytes / BYTES_PER_MB;
  if (megabytes < MB_PER_GB) return `${Math.round(megabytes)} MB`;
  return `${(megabytes / MB_PER_GB).toFixed(1)} GB`;
}

/** "0.4%" — always one decimal place, matching PM2's own monit.cpu precision. */
export function formatCpuPercent(percent: number): string {
  return `${percent.toFixed(1)}%`;
}
