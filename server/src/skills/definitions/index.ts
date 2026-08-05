/**
 * Barrel export of all skill definitions.
 *
 * Skills are listed in the order they should be registered.
 * Adding a new skill: create a .skill.ts file and add it here.
 */

import type { SkillDefinition } from '../types.js';
import { salesSkill } from './sales.skill.js';
import { calendarSkill } from './calendar.skill.js';
import { transcriptSkill } from './transcript.skill.js';
import { enablementSkill } from './enablement.skill.js';
import { prospectingSkill } from './prospecting.skill.js';
import { salesforceSkill } from './salesforce.skill.js';
import { attioSkill } from './attio.skill.js';
import { conversationalSkill } from './conversational.skill.js';
import { reminderSkill } from './reminder.skill.js';
import { settingsSkill } from './settings.skill.js';

export const allSkills: SkillDefinition[] = [
  salesSkill,
  calendarSkill,
  transcriptSkill,
  enablementSkill,
  prospectingSkill,
  salesforceSkill,
  attioSkill,
  reminderSkill,
  settingsSkill,
  conversationalSkill, // Keep conversational last as fallback
];

export {
  salesSkill,
  calendarSkill,
  transcriptSkill,
  enablementSkill,
  prospectingSkill,
  salesforceSkill,
  attioSkill,
  reminderSkill,
  settingsSkill,
  conversationalSkill,
};
