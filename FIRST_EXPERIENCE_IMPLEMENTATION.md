# First Experience Trial System — Implementation Complete

## Overview
The First Experience trial system provides free users with structured, one-time access to AIRRA's 3 core premium features before they subscribe. Each trial grants limited but full-featured access to unlock conversion.

---

## Database Schema

### Table: `first_experience_usage`
Tracks trial consumption per user, per action.

```sql
CREATE TABLE first_experience_usage (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action_key      TEXT NOT NULL,  -- 'rival_spy_trial' | 'studio_trial' | 'video_dna_trial'
  used_at         TIMESTAMPTZ DEFAULT NOW(),
  result_data     JSONB,          -- store result for revisiting
  converted_to_pro BOOLEAN DEFAULT FALSE,
  converted_at    TIMESTAMPTZ,
  UNIQUE(user_id, action_key)
);
```

### Prisma Model
```prisma
model first_experience_usage {
  id              String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  user_id         String    @db.Uuid
  action_key      String    // 'rival_spy_trial' | 'studio_trial' | 'video_dna_trial'
  used_at         DateTime  @default(now()) @db.Timestamptz(6)
  result_data     Json?     // store the result so they can revisit it
  converted_to_pro Boolean   @default(false)
  converted_at    DateTime? @db.Timestamptz(6)
  users           users     @relation(fields: [user_id], references: [id], onDelete: Cascade)

  @@unique([user_id, action_key])
  @@index([user_id])
  @@index([user_id, action_key])
}
```

---

## Trial Actions

| Action Key | Feature | Real Credit Action | Limit |
|---|---|---|---|
| `rival_spy_trial` | Rival Spy | `rival_spy` | 1 session, 3 handles |
| `studio_trial` | Studio Script | `script_writing` | 1 full script |
| `video_dna_trial` | Video DNA | `video_analysis` | 1 video analysis |

Mapping in code:
```typescript
const TRIAL_TO_REAL: Record<TrialAction, string> = {
  rival_spy_trial: 'rival_spy',
  studio_trial: 'script_writing',
  video_dna_trial: 'video_analysis',
};
```

---

## API Functions

### `canUseTrial(userId, action)`

**Purpose**: Check if user is eligible for a specific trial

**Parameters**:
- `userId`: User ID
- `action`: Trial action key (`rival_spy_trial` | `studio_trial` | `video_dna_trial`)

**Returns**:
```typescript
{
  canUse: boolean;        // true if user can use this trial
  alreadyUsed: boolean;   // true if trial was already consumed
  reason?: string;        // explanation if cannot use
}
```

**Logic**:
1. Fetch user's `subscription_tier`
2. If NOT `'free'`: return `{ canUse: false, alreadyUsed: false, reason: 'Not on free tier' }`
3. Check for existing row in `first_experience_usage` with this user + action
4. If found: return `{ canUse: false, alreadyUsed: true }`
5. If not found: return `{ canUse: true, alreadyUsed: false }`

**Error Handling**: Wrapped in try/catch — **fail open** (return canUse: true) if DB error

**Usage in Controllers**:
```typescript
const { canUse, alreadyUsed } = await canUseTrial(user.id, 'rival_spy_trial');

if (!canUse) {
  if (alreadyUsed) {
    // Offer: "You've already used your free trial. Upgrade to Pro to unlock unlimited access."
    return errors.conflict(reply, 'Trial already used');
  }
  // Non-free user — they use normal credits
  // Continue with credit check
}

// canUse === true → proceed with trial
```

---

### `markTrialUsed(userId, action, resultData?)`

**Purpose**: Mark a trial as consumed after successful completion

**Parameters**:
- `userId`: User ID
- `action`: Trial action key
- `resultData` (optional): Store the trial result (e.g., rival analysis JSON) for later retrieval

**Returns**: `Promise<void>`

**Behavior**:
- Upserts row into `first_experience_usage` (creates if not exists, updates if exists)
- Sets `used_at` to NOW
- Stores `result_data` if provided
- Invalidates cache: `trial_status:${userId}`

**Non-Fatal**: Always logs but never throws — called after success, in background

**Usage in Controllers**:
```typescript
// After successful rival analysis
const resultData = { handles: ['@user1', '@user2', '@user3'], analysis: {...} };
await markTrialUsed(user.id, 'rival_spy_trial', resultData).catch(err => 
  logger.warn({ err }, 'Non-fatal: failed to mark trial')
);
```

---

### `getTrialStatus(userId)`

**Purpose**: Get complete trial status for a user (used by frontend)

**Parameters**:
- `userId`: User ID

**Returns**:
```typescript
{
  rival_spy_trial: { used: boolean; usedAt?: string };
  studio_trial: { used: boolean; usedAt?: string };
  video_dna_trial: { used: boolean; usedAt?: string };
  allUsed: boolean;              // true if all 3 trials consumed
  convertedToPro: boolean;       // true if user upgraded after using trials
}
```

**Caching**:
- Fetches from `trial_status:${userId}` (Redis, 5-minute TTL)
- If miss, queries DB and caches result
- Cache invalidated on `markTrialUsed` or `markTrialsConverted`

**Error Handling**: Returns default (all unused) if DB error

**Usage in Frontend**:
```javascript
const { data: trialsData } = useTrialStatus();
const trials = trialsData?.data;

if (!trials.allUsed) {
  // Show "Start Free Trial" button for unused trials
}
if (trials.rival_spy_trial.used) {
  // Show "Upgrade to unlock more analyses" CTA
}
```

---

### `markTrialsConverted(userId)`

**Purpose**: Called when user upgrades to Pro subscription

**Parameters**:
- `userId`: User ID

**Behavior**:
- Updates all `first_experience_usage` rows for this user
- Sets `converted_to_pro = true`
- Sets `converted_at = NOW`
- Invalidates cache

**Non-Fatal**: Logs warnings but never throws

**Usage in Subscription Controller**:
```typescript
// After successful Pro subscription
await markTrialsConverted(user.id).catch(err =>
  logger.warn({ err }, 'Non-fatal: failed to mark trials converted')
);
```

---

### Utility Functions

#### `getTrialResult(userId, action)`
Retrieve stored result from a completed trial (e.g., to show "Last analysis" on dashboard)

```typescript
const result = await getTrialResult(user.id, 'rival_spy_trial');
// returns: { handles: [...], analysis: {...} } or null
```

#### `hasAvailableTrial(userId)`
Check if user has ANY trial remaining

```typescript
const hasTrials = await hasAvailableTrial(user.id);
if (!hasTrials) {
  // All 3 trials used — show "Upgrade now" modal
}
```

---

## Integration Points

### 1. Rival Spy Controller (`src/controllers/rival.controller.ts`)

Before deducting credits:
```typescript
const rivalController = async (req: FastifyRequest, reply: FastifyReply) => {
  const user = req.user as User;
  
  // Check if user can use trial
  const { canUse } = await canUseTrial(user.id, 'rival_spy_trial');
  
  if (canUse) {
    // Proceed with trial (no credit deduction)
    const result = await performRivalAnalysis(handles);
    
    // Mark trial as used (non-blocking)
    await markTrialUsed(user.id, 'rival_spy_trial', result).catch(() => {});
    
    return success(reply, { result, trial: true });
  }
  
  // Not on free tier or trial already used — use normal credits
  // Existing credit check logic
};
```

### 2. Studio Controller (`src/controllers/studio.controller.ts`)

Same pattern:
```typescript
const { canUse } = await canUseTrial(user.id, 'studio_trial');

if (canUse) {
  const script = await generateScript(prompt);
  await markTrialUsed(user.id, 'studio_trial', script).catch(() => {});
  return success(reply, { script, trial: true });
}

// Credit check and normal flow
```

### 3. Video DNA Controller (`src/controllers/deepAnalysis.controller.ts`)

Same pattern:
```typescript
const { canUse } = await canUseTrial(user.id, 'video_dna_trial');

if (canUse) {
  const analysis = await analyzeVideo(videoUrl);
  await markTrialUsed(user.id, 'video_dna_trial', analysis).catch(() => {});
  return success(reply, { analysis, trial: true });
}

// Credit check
```

### 4. Subscription Service (`src/services/subscription.service.ts`)

When user upgrades:
```typescript
export async function upgradeUserToPro(userId: string, ...) {
  // ... subscription logic
  
  // Mark trials as converted (non-blocking)
  await markTrialsConverted(userId).catch(() => {});
}
```

### 5. Frontend Hook (`src/hooks/useApi.js`)

Add new query:
```javascript
export const useTrialStatus = () =>
  useQuery({
    queryKey: ['trial-status'],
    queryFn: () => api.get('/users/trial-status'),
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
```

Add controller endpoint:
```typescript
// GET /api/v1/users/trial-status
export const getTrialStatus = async (req: FastifyRequest, reply: FastifyReply) => {
  const user = req.user as User;
  const status = await getTrialStatus(user.id);
  return success(reply, status);
};
```

---

## Error Handling Strategy

### Fail-Open Philosophy
All trial checks are **non-blocking**:
- If `canUseTrial` DB query fails → allow user to proceed
- If `markTrialUsed` fails → log warning, don't block response
- If `getTrialStatus` fails → return default (all unused)

**Why**: Better to give a user an extra free trial than block them due to DB issues.

### Try-Catch Wrapping
Every DB call wrapped in try-catch with appropriate logging:

```typescript
try {
  // DB operation
} catch (err: any) {
  logger.warn({ err: err.message, userId }, 'Operation failed');
  return defaultValue; // fail open
}
```

---

## Cache Invalidation

### Cache Key
`trial_status:${userId}`

### Invalidated When
- User completes a trial: `markTrialUsed()` invalidates
- User upgrades to Pro: `markTrialsConverted()` invalidates

### TTL
5 minutes (300 seconds)

---

## Metrics & Analytics

### Conversion Funnel
1. **Trials Created**: COUNT WHERE `used_at` IS NOT NULL
2. **Trials Converted**: COUNT WHERE `converted_to_pro = true`
3. **Conversion Rate**: converted / created
4. **Time to Conversion**: AVG(converted_at - used_at)

### Query Examples

```sql
-- Users who used each trial
SELECT action_key, COUNT(DISTINCT user_id) as users
FROM first_experience_usage
GROUP BY action_key;

-- Conversion rate by trial
SELECT 
  action_key,
  COUNT(*) as total_trials,
  COUNT(CASE WHEN converted_to_pro THEN 1 END) as converted,
  ROUND(100.0 * COUNT(CASE WHEN converted_to_pro THEN 1 END) / COUNT(*), 2) as conversion_pct
FROM first_experience_usage
GROUP BY action_key;

-- Users who completed all 3 trials
SELECT user_id, COUNT(*) as trials_used
FROM first_experience_usage
WHERE user_id IN (SELECT user_id FROM first_experience_usage GROUP BY user_id HAVING COUNT(*) = 3)
GROUP BY user_id;
```

---

## TypeScript Types

```typescript
export const TRIAL_ACTIONS = [
  'rival_spy_trial',
  'studio_trial',
  'video_dna_trial',
] as const;

export type TrialAction = typeof TRIAL_ACTIONS[number];

export const TRIAL_TO_REAL: Record<TrialAction, string> = {
  rival_spy_trial: 'rival_spy',
  studio_trial: 'script_writing',
  video_dna_trial: 'video_analysis',
};
```

---

## Status

✅ **Database Migration**: Created (`prisma/migrations/first_experience/migration.sql`)
✅ **Prisma Schema**: Updated with `first_experience_usage` model
✅ **Service Implementation**: Complete (`src/services/firstExperience.service.ts`)
✅ **Error Handling**: Fail-open, non-blocking
✅ **Caching**: 5-minute Redis cache with invalidation
✅ **TypeScript**: Fully typed

**Ready for**: Integration into Rival Spy, Studio, Video DNA, and Subscription controllers

---

## Migration Checklist

- [ ] Run migration: `prisma migrate deploy` or apply SQL directly
- [ ] Update Prisma client: `prisma generate`
- [ ] Integrate `canUseTrial` check into Rival Spy controller
- [ ] Integrate `canUseTrial` check into Studio controller
- [ ] Integrate `canUseTrial` check into Video DNA controller
- [ ] Integrate `markTrialUsed` into all 3 controllers
- [ ] Integrate `markTrialsConverted` into subscription upgrade flow
- [ ] Add `/users/trial-status` endpoint
- [ ] Add frontend hook: `useTrialStatus`
- [ ] Test trial flow: free user → use trial → mark used → verify status
- [ ] Test conversion: free user → upgrade to Pro → verify trials marked converted

---

**Last Updated**: May 24, 2026  
**Status**: Ready for Integration
