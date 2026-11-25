/** Typed errors of dynamic workflow plans: validation, template rendering and the planner. */

export type DynamicPlanErrorCode =
  | 'NOT_JSON' | 'SHAPE' | 'UNKNOWN_KEY' | 'MISSING' | 'TYPE' | 'FORMAT' | 'LABEL' | 'ID' | 'DUPLICATE'
  | 'TEMPLATE' | 'REFERENCE' | 'CYCLE' | 'PHASE' | 'PERMISSIONS' | 'MODEL' | 'LIMIT' | 'SCHEMA' | 'SCHEMA_PATTERN' | 'RESULT'
  | 'MISSING_VALUE' | 'OVER_NOT_ARRAY' | 'MAX_ITEMS' | 'PROMPT_TOO_LARGE';

/** One problem, located by a JSON path into the plan (`$.steps[2].prompt`). */
export interface DynamicPlanIssue {
  readonly code: DynamicPlanErrorCode;
  readonly path: string;
  readonly message: string;
}

/**
 * A plan that cannot be accepted or run. `code` and `path` are the first issue; `issues` holds every
 * issue found (validation keeps going after the first one, up to a bound), so a planner can repair them all.
 */
export class DynamicPlanError extends Error {
  readonly code: DynamicPlanErrorCode;
  readonly path: string;
  readonly issues: readonly DynamicPlanIssue[];

  constructor(issues: readonly DynamicPlanIssue[]) {
    const first = issues[0] ?? { code: 'SHAPE' as const, path: '$', message: 'Invalid plan' };
    const more = issues.length > 1 ? ` (and ${issues.length - 1} more)` : '';
    super(`${first.path}: ${first.message}${more}`);
    this.name = 'DynamicPlanError';
    this.code = first.code;
    this.path = first.path;
    this.issues = Object.freeze(issues.map(issue => Object.freeze({ ...issue })));
  }

  static of(code: DynamicPlanErrorCode, path: string, message: string): DynamicPlanError {
    return new DynamicPlanError([{ code, path, message }]);
  }
}

/** The planner gave up: every attempt (the first and each repair) produced an invalid plan. */
export class DynamicPlannerError extends Error {
  readonly code = 'PLAN_INVALID' as const;

  constructor(readonly attempts: number, readonly issues: readonly DynamicPlanIssue[]) {
    super(`The planner produced no valid plan in ${attempts} attempt${attempts === 1 ? '' : 's'}`);
    this.name = 'DynamicPlannerError';
  }
}
