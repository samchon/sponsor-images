import { createHash } from "node:crypto";
import process from "node:process";
import sharp from "sharp";
import {
  defineConfig,
  resizeImage,
  type ImageFormat,
  type Provider,
  type SponsorkitConfig,
  type SvgComposer,
  type Sponsorship,
} from "sponsorkit";

const OPEN_COLLECTIVE_SLUGS = ["typia", "nestia", "tstl"] as const;
const AVATAR_DHASH_MAX_DISTANCE = 7;

const OC_API = "https://api.opencollective.com/graphql/v2/";
const GH_API = "https://api.github.com/graphql";

interface OcSocialLink {
  type: string;
  url: string;
}

interface OcAccount {
  id: string;
  slug: string;
  name: string;
  type: string;
  isIncognito: boolean;
  imageUrl: string;
  socialLinks?: OcSocialLink[];
}

interface OcTransaction {
  amount: { value: number };
  createdAt: string;
  isRefund: boolean;
  isRefunded: boolean;
  fromAccount: OcAccount;
  order?: {
    frequency?: "ONETIME" | "MONTHLY" | "YEARLY" | string;
    tier?: { name?: string };
  };
}

const GITHUB_RE = /github\.com\/([^/]+)/i;

function getSocialLogins(
  links: OcSocialLink[] | undefined,
  ocLogin: string,
): Record<string, string> {
  const result: Record<string, string> = { opencollective: ocLogin };
  for (const link of links ?? []) {
    if (link.type === "GITHUB") {
      const m = link.url.match(GITHUB_RE);
      if (m?.[1]) result.github = m[1];
    }
  }
  return result;
}

function getBestUrl(links: OcSocialLink[] | undefined): string | undefined {
  const priority = [
    "WEBSITE",
    "GITHUB",
    "GITLAB",
    "TWITTER",
    "LINKEDIN",
    "FACEBOOK",
    "YOUTUBE",
    "INSTAGRAM",
    "DISCORD",
    "TUMBLR",
  ];
  for (const t of priority) {
    const hit = links?.find((l) => l.type === t);
    if (hit?.url) return hit.url;
  }
  return undefined;
}

function getAccountType(t: string): "User" | "Organization" {
  return t === "INDIVIDUAL" ? "User" : "Organization";
}

async function fetchOpenCollectiveCredits(
  key: string,
  slug: string,
): Promise<OcTransaction[]> {
  const txs: OcTransaction[] = [];
  let offset = 0;
  while (true) {
    const query = `{
      account(slug: "${slug}") {
        transactions(
          limit: 1000,
          offset: ${offset},
          type: CREDIT,
          kind: [CONTRIBUTION]
        ) {
          totalCount
          nodes {
            amount { value }
            createdAt
            isRefund
            isRefunded
            order { frequency tier { name } }
            fromAccount {
              id
              slug
              name
              type
              isIncognito
              imageUrl(height: 460, format: png)
              socialLinks { url type }
            }
          }
        }
      }
    }`;
    const res = await fetch(OC_API, {
      method: "POST",
      headers: {
        "Api-Key": key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) {
      throw new Error(
        `OpenCollective fetch failed for ${slug}: ${res.status} ${res.statusText}`,
      );
    }
    const json = (await res.json()) as {
      data?: {
        account?: {
          transactions?: { totalCount: number; nodes: OcTransaction[] };
        };
      };
      errors?: unknown;
    };
    if (json.errors) {
      throw new Error(
        `OpenCollective GraphQL error for ${slug}: ${JSON.stringify(json.errors)}`,
      );
    }
    const page = json.data?.account?.transactions;
    if (!page) break;
    txs.push(...page.nodes);
    if (page.nodes.length === 0 || txs.length >= page.totalCount) break;
    offset += page.nodes.length;
  }
  return txs;
}

function makeOpenCollectiveProvider(slug: string): Provider {
  return {
    name: `opencollective:${slug}`,
    async fetchSponsors() {
      const key = process.env.SPONSORKIT_OPENCOLLECTIVE_KEY;
      if (!key)
        throw new Error("SPONSORKIT_OPENCOLLECTIVE_KEY is required");

      // Pull every CREDIT contribution (one row per charge) and aggregate per
      // fromAccount — ground-truth lifetime sum, no per-order or
      // `totalDonations` ambiguity.
      const txs = await fetchOpenCollectiveCredits(key, slug);

      const byAccount = new Map<string, Sponsorship>();
      for (const t of txs) {
        if (t.isRefund || t.isRefunded) continue;
        if (t.fromAccount.slug === "github-sponsors") continue;
        if (t.amount.value <= 0) continue;

        const id = t.fromAccount.id;
        const existing = byAccount.get(id);
        if (existing) {
          existing.monthlyDollars += t.amount.value;
          if (
            t.createdAt &&
            (!existing.createdAt || t.createdAt < existing.createdAt)
          )
            existing.createdAt = t.createdAt;
          continue;
        }

        byAccount.set(id, {
          sponsor: {
            type: getAccountType(t.fromAccount.type),
            login: t.fromAccount.slug,
            name: t.fromAccount.name,
            avatarUrl: t.fromAccount.imageUrl,
            websiteUrl: getBestUrl(t.fromAccount.socialLinks),
            linkUrl: `https://opencollective.com/${t.fromAccount.slug}`,
            socialLogins: getSocialLogins(
              t.fromAccount.socialLinks,
              t.fromAccount.slug,
            ),
          },
          monthlyDollars: t.amount.value,
          isOneTime: t.order?.frequency === "ONETIME",
          privacyLevel: t.fromAccount.isIncognito ? "PRIVATE" : "PUBLIC",
          tierName: t.order?.tier?.name,
          createdAt: t.createdAt,
        });
      }
      return [...byAccount.values()];
    },
  };
}

interface GhSponsorshipNode {
  createdAt: string;
  privacyLevel: "PUBLIC" | "PRIVATE";
  isActive: boolean;
  tier: {
    name: string;
    isOneTime: boolean;
    monthlyPriceInDollars: number;
  } | null;
  sponsorEntity: {
    __typename: "User" | "Organization";
    login: string;
    name: string | null;
    avatarUrl: string;
    websiteUrl: string | null;
  };
}

async function fetchGitHubSponsorNodes(
  token: string,
  login: string,
): Promise<GhSponsorshipNode[]> {
  const nodes: GhSponsorshipNode[] = [];
  let cursor: string | null = null;
  while (true) {
    const query = `{
      user(login: "${login}") {
        sponsorshipsAsMaintainer(activeOnly: false, first: 100${cursor ? `, after: "${cursor}"` : ""}) {
          pageInfo { endCursor hasNextPage }
          nodes {
            createdAt
            privacyLevel
            isActive
            tier { name isOneTime monthlyPriceInDollars }
            sponsorEntity {
              __typename
              ... on Organization { login name avatarUrl websiteUrl }
              ... on User { login name avatarUrl websiteUrl }
            }
          }
        }
      }
    }`;
    const res = await fetch(GH_API, {
      method: "POST",
      headers: {
        Authorization: `bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "sponsorkit-typia",
      },
      body: JSON.stringify({ query }),
    });
    if (!res.ok)
      throw new Error(`GitHub fetch failed: ${res.status} ${res.statusText}`);
    const json = (await res.json()) as {
      data?: {
        user?: {
          sponsorshipsAsMaintainer: {
            pageInfo: { endCursor: string | null; hasNextPage: boolean };
            nodes: GhSponsorshipNode[];
          };
        };
      };
      errors?: { type?: string; message?: string }[];
    };
    if (json.errors?.length) {
      const scope = json.errors.find((e) => e.type === "INSUFFICIENT_SCOPES");
      if (scope)
        throw new Error(
          "GitHub token missing `read:user` and/or `read:org` scopes",
        );
      throw new Error(`GitHub API error: ${JSON.stringify(json.errors)}`);
    }
    const page = json.data?.user?.sponsorshipsAsMaintainer;
    if (!page) break;
    nodes.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }
  return nodes;
}

function monthsBetween(start: Date, end: Date): number {
  // Inclusive count of months between two dates (always ≥ 1).
  return Math.max(
    1,
    (end.getUTCFullYear() - start.getUTCFullYear()) * 12 +
      (end.getUTCMonth() - start.getUTCMonth()) +
      1,
  );
}

const githubProvider: Provider = {
  name: "github",
  async fetchSponsors() {
    const token = process.env.SPONSORKIT_GITHUB_TOKEN;
    const login = process.env.SPONSORKIT_GITHUB_LOGIN;
    if (!token) throw new Error("SPONSORKIT_GITHUB_TOKEN is required");
    if (!login) throw new Error("SPONSORKIT_GITHUB_LOGIN is required");

    const nodes = await fetchGitHubSponsorNodes(token, login);
    const now = new Date();

    return nodes
      .filter((n) => n.tier)
      .map<Sponsorship | null>((n) => {
        const tier = n.tier!;
        const monthly = tier.monthlyPriceInDollars;
        // GitHub does not expose an end date for past sponsorships, so we
        // estimate lifetime as one month for one-time / inactive sponsors and
        // months-since-createdAt × monthly for active recurring sponsors.
        const lifetime = tier.isOneTime
          ? monthly
          : n.isActive
            ? monthsBetween(new Date(n.createdAt), now) * monthly
            : monthly;
        if (lifetime <= 0) return null;
        return {
          sponsor: {
            type: n.sponsorEntity.__typename,
            login: n.sponsorEntity.login,
            name: n.sponsorEntity.name ?? n.sponsorEntity.login,
            avatarUrl: n.sponsorEntity.avatarUrl,
            websiteUrl: n.sponsorEntity.websiteUrl ?? undefined,
            linkUrl: `https://github.com/${n.sponsorEntity.login}`,
            socialLogins: { github: n.sponsorEntity.login },
          },
          monthlyDollars: lifetime,
          isOneTime: tier.isOneTime,
          privacyLevel: n.privacyLevel,
          tierName: tier.name,
          createdAt: n.createdAt,
        };
      })
      .filter((s): s is Sponsorship => s !== null);
  },
};

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function normalizeAccountMergeKey(value: string | null | undefined): string | undefined {
  const key = value
    ?.normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/^@+/, "")
    .replace(/[\s._-]+/g, "");
  if (!key || key.length < 4) return undefined;
  if (/^guest[0-9a-f]+$/.test(key)) return undefined;
  if (["anonymous", "private", "sponsor", "supporter", "unknown"].includes(key))
    return undefined;
  return key;
}

function getAccountMergeKeys(sponsorship: Sponsorship): string[] {
  return [
    sponsorship.sponsor.login,
    sponsorship.sponsor.name,
  ].flatMap((value) => {
    const key = normalizeAccountMergeKey(value);
    return key ? [key] : [];
  });
}

function hasGitHubProvider(sponsorship: Sponsorship): boolean {
  return sponsorship.provider?.split("+").includes("github") ?? false;
}

function compareSponsorships(a: Sponsorship, b: Sponsorship): number {
  return (
    b.monthlyDollars - a.monthlyDollars ||
    Date.parse(a.createdAt ?? "") - Date.parse(b.createdAt ?? "") ||
    (a.sponsor.login || a.sponsor.name).localeCompare(
      b.sponsor.login || b.sponsor.name,
    )
  );
}

function getAvatarMergeKey(sponsorship: Sponsorship): string | undefined {
  if (!sponsorship.sponsor.avatarBuffer) return undefined;
  if (!sponsorship.sponsor.avatarUrl) return undefined;
  if (sponsorship.privacyLevel === "PRIVATE") return undefined;
  return createHash("sha256")
    .update(sponsorship.sponsor.avatarBuffer)
    .digest("hex");
}

async function getAvatarDHash(
  sponsorship: Sponsorship,
): Promise<bigint | undefined> {
  if (!sponsorship.sponsor.avatarBuffer) return undefined;
  if (!sponsorship.sponsor.avatarUrl) return undefined;
  if (sponsorship.privacyLevel === "PRIVATE") return undefined;

  const data = await sharp(sponsorship.sponsor.avatarBuffer)
    .resize(9, 8, { fit: "fill" })
    .grayscale()
    .raw()
    .toBuffer();
  let hash = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      hash <<= 1n;
      if (data[y * 9 + x] > data[y * 9 + x + 1]) hash |= 1n;
    }
  }
  return hash;
}

function getHashDistance(a: bigint, b: bigint): number {
  let distance = 0;
  let xor = a ^ b;
  while (xor) {
    distance += Number(xor & 1n);
    xor >>= 1n;
  }
  return distance;
}

function mergeSponsorship(target: Sponsorship, source: Sponsorship): Sponsorship {
  const canonical =
    hasGitHubProvider(source) && !hasGitHubProvider(target) ? source : target;
  const other = canonical === target ? source : target;

  canonical.monthlyDollars += other.monthlyDollars;
  canonical.isOneTime = Boolean(canonical.isOneTime && other.isOneTime);
  canonical.provider = [...new Set(
    [canonical.provider, other.provider].flatMap((provider) =>
      provider ? provider.split("+") : [],
    ),
  )].join("+");
  canonical.sponsor.socialLogins = {
    ...other.sponsor.socialLogins,
    ...canonical.sponsor.socialLogins,
  };
  if (!canonical.sponsor.websiteUrl && other.sponsor.websiteUrl)
    canonical.sponsor.websiteUrl = other.sponsor.websiteUrl;
  if (!canonical.sponsor.linkUrl && other.sponsor.linkUrl)
    canonical.sponsor.linkUrl = other.sponsor.linkUrl;
  if (
    other.createdAt &&
    (!canonical.createdAt || other.createdAt < canonical.createdAt)
  )
    canonical.createdAt = other.createdAt;
  if (
    other.expireAt &&
    (!canonical.expireAt || other.expireAt > canonical.expireAt)
  )
    canonical.expireAt = other.expireAt;

  return canonical;
}

async function mergeByAvatar(sponsors: Sponsorship[]): Promise<Sponsorship[]> {
  const byAvatar = new Map<string, Sponsorship>();
  const exactMerged: Sponsorship[] = [];

  for (const sponsorship of sponsors) {
    const key = getAvatarMergeKey(sponsorship);
    if (!key) {
      exactMerged.push(sponsorship);
      continue;
    }

    const existing = byAvatar.get(key);
    if (!existing) {
      byAvatar.set(key, sponsorship);
      exactMerged.push(sponsorship);
      continue;
    }

    const canonical = mergeSponsorship(existing, sponsorship);
    byAvatar.set(key, canonical);
    if (canonical !== existing) {
      const index = exactMerged.indexOf(existing);
      if (index >= 0) exactMerged[index] = canonical;
    }
  }

  const result: Sponsorship[] = [];
  const perceptualHashes: { hash: bigint; sponsorship: Sponsorship }[] = [];
  for (const sponsorship of exactMerged) {
    const hash = await getAvatarDHash(sponsorship);
    if (hash === undefined) {
      result.push(sponsorship);
      continue;
    }

    const existing = perceptualHashes.find(
      (entry) => getHashDistance(entry.hash, hash) <= AVATAR_DHASH_MAX_DISTANCE,
    );
    if (!existing) {
      result.push(sponsorship);
      perceptualHashes.push({ hash, sponsorship });
      continue;
    }

    const previous = existing.sponsorship;
    const canonical = mergeSponsorship(previous, sponsorship);
    existing.sponsorship = canonical;
    if (canonical !== previous) {
      const index = result.indexOf(previous);
      if (index >= 0) result[index] = canonical;
    }
  }

  return result.sort(compareSponsorships);
}

async function composeBadge(
  composer: SvgComposer,
  sponsors: Sponsorship[],
  config: SponsorkitConfig,
): Promise<void> {
  const avatarSize = 75;
  const rowStep = 80;
  const perRow = 7;
  const sorted = sponsors
    .filter((s) => s.monthlyDollars > 0)
    .sort(compareSponsorships);
  if (sorted.length === 0) return;

  const rows = Math.ceil(sorted.length / perRow);
  composer.height = rows * rowStep - (rowStep - avatarSize);
  const imageFormat: ImageFormat = config.imageFormat ?? "webp";

  for (const [index, sponsorship] of sorted.entries()) {
    const x =
      (index % perRow) * (config.width ?? 600) / perRow +
      ((config.width ?? 600) / perRow - avatarSize) / 2;
    const y = Math.floor(index / perRow) * rowStep;
    const sponsor = sponsorship.sponsor;
    const url = sponsor.websiteUrl || sponsor.linkUrl;
    const avatar = await resizeImage(
      sponsor.avatarBuffer!,
      avatarSize,
      imageFormat,
    );
    const clipId = `square-avatar-${index}`;

    composer.addRaw(`<a ${url ? `href="${escapeAttribute(url)}" ` : ""}class="sponsorkit-link" target="_blank" id="${escapeAttribute(sponsor.login)}">
  <clipPath id="${clipId}">
    <circle cx="${x + avatarSize / 2}" cy="${y + avatarSize / 2}" r="${avatarSize / 2}" />
  </clipPath>
  <image x="${x}" y="${y}" width="${avatarSize}" height="${avatarSize}" href="data:image/${imageFormat};base64,${avatar.toString("base64")}" clip-path="url(#${clipId})" />
</a>`);
  }
}

export default defineConfig({
  providers: [
    githubProvider,
    ...OPEN_COLLECTIVE_SLUGS.map(makeOpenCollectiveProvider),
  ],
  // GH ↔ OC merge runs through sponsorkit's auto-merge (matches on
  // socialLogins.github → github provider/login).
  sponsorsAutoMerge: true,
  // monthlyDollars holds lifetime totals here; render every contributor.
  includePastSponsors: true,
  // Cross-OpenCollective dedupe: sponsorkit's sponsorsAutoMerge keys on
  // `provider + login`, but our three OC providers are namespaced
  // (`opencollective:typia` etc.) so a person sponsoring two of typia /
  // nestia / tstl on OC would survive as separate entries. Fold them by OC
  // slug here, before auto-merge runs. Then do a conservative account-name
  // fold so GitHub and OpenCollective entries without social links can still
  // merge when their account names match.
  onSponsorsAllFetched: (sponsors) => {
    const byOcSlug = new Map<string, Sponsorship>();
    const byAccountName = new Map<string, Sponsorship>();
    const ocMerged: Sponsorship[] = [];
    const result: Sponsorship[] = [];
    for (const s of sponsors) {
      const ocSlug = s.sponsor.socialLogins?.opencollective?.toLowerCase();
      if (!ocSlug) {
        ocMerged.push(s);
        continue;
      }
      const existing = byOcSlug.get(ocSlug);
      if (!existing) {
        byOcSlug.set(ocSlug, s);
        ocMerged.push(s);
        continue;
      }
      mergeSponsorship(existing, s);
    }
    for (const s of ocMerged) {
      const keys = getAccountMergeKeys(s);
      const existing = keys
        .map((key) => byAccountName.get(key))
        .find((matched): matched is Sponsorship => !!matched);
      if (existing) {
        const canonical = mergeSponsorship(existing, s);
        if (canonical !== existing) {
          const index = result.indexOf(existing);
          if (index >= 0) result[index] = canonical;
          for (const [key, value] of byAccountName) {
            if (value === existing) byAccountName.set(key, canonical);
          }
        }
        for (const key of keys) byAccountName.set(key, canonical);
        continue;
      }
      result.push(s);
      for (const key of keys) byAccountName.set(key, s);
    }
    return result;
  },
  // Avatar buffers are available only after SponsorKit resolves avatars.
  // If an avatar match contains a GitHub entry, keep the GitHub account as
  // the visible account; otherwise preserve the first OpenCollective entry.
  onSponsorsReady: (sponsors) => mergeByAvatar(sponsors),
  outputDir: "public",
  // SponsorKit always writes a cache file; npm start runs with --force, so discard it.
  cacheFile: "/dev/null",
  width: 800,
  renders: [
    {
      name: "circle",
      renderer: "circles",
      formats: ["svg"],
      circles: {
        radiusMin: 14,
        radiusMax: 110,
      },
    },
    {
      name: "square",
      renderer: "tiers",
      formats: ["svg"],
      width: 600,
      customComposer: composeBadge,
    },
  ],
});
