import { authedFetch, type ApiResult } from './api';
import type {
  AppDetail, AppSummary, OrgSummary, QueryDetail, QueryListResponse, SeriesResponse,
} from './dashboard-types';
import type { Session } from './auth';

const e = encodeURIComponent;
const windowQuery = (w: { from: string; to: string }) => new URLSearchParams(w).toString();

export const getMe = (t: string): Promise<ApiResult<Session['user']>> => authedFetch('/v1/me', t);
export const listOrgs = (t: string): Promise<ApiResult<OrgSummary[]>> => authedFetch('/v1/orgs', t);
/** `orgId` is the organization's id, NOT its slug: the API's `:org` param is an id (rbac.ts requireRole). */
export const listApps = (t: string, orgId: string): Promise<ApiResult<AppSummary[]>> =>
  authedFetch(`/v1/orgs/${e(orgId)}/apps`, t);
export const getApp = (t: string, app: string): Promise<ApiResult<AppDetail>> => authedFetch(`/v1/apps/${e(app)}`, t);
export const listQueries = (t: string, app: string, apiQuery: string): Promise<ApiResult<QueryListResponse>> =>
  authedFetch(`/v1/apps/${e(app)}/queries?${apiQuery}`, t);
/** The detail endpoint is all-time and ignores from/to, so it takes no window. */
export const getQuery = (t: string, app: string, hash: string): Promise<ApiResult<QueryDetail>> =>
  authedFetch(`/v1/apps/${e(app)}/queries/${e(hash)}`, t);
export const getSeries = (t: string, app: string, hash: string, w: { from: string; to: string }): Promise<ApiResult<SeriesResponse>> =>
  authedFetch(`/v1/apps/${e(app)}/queries/${e(hash)}/series?${windowQuery(w)}`, t);
