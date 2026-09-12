export const okfxVersion = "0.1.2";
export const supportedOkfVersions = ["0.1"] as const;
export type SupportedOkfVersion = typeof supportedOkfVersions[number];

export function isSupportedOkfVersion(version: string | undefined): version is SupportedOkfVersion {
  return supportedOkfVersions.includes(version as SupportedOkfVersion);
}
