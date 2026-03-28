/**
 * CSI plugin for OpenCode.ai
 *
 * Registers the repository's skills/ directory via the config hook so
 * OpenCode discovers the csi and csi-e2e skills without symlinks or
 * manual config edits. Zero dependencies.
 */

import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const csiSkillsDir = path.resolve(__dirname, "../../skills");

export const CsiPlugin = async () => {
  return {
    config: async (config) => {
      config.skills = config.skills || {};
      config.skills.paths = config.skills.paths || [];
      if (!config.skills.paths.includes(csiSkillsDir)) {
        config.skills.paths.push(csiSkillsDir);
      }
    },
  };
};
