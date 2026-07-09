import packageJson from "../../package.json";

export interface RuntimeInfo {
  version: string;
  revision?: string;
}

export function getRuntimeInfo(env: NodeJS.ProcessEnv = process.env): RuntimeInfo {
  const configuredVersion = env.MOODARR_VERSION?.trim();
  const configuredRevision = env.MOODARR_BUILD_REVISION?.trim();
  return {
    version: configuredVersion || packageJson.version,
    revision: configuredRevision || undefined
  };
}
