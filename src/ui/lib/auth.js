import { headers } from "next/headers";
import prisma from "@/lib/prisma";
import { Roles } from "@/lib/rbac";

export const AuthModes = {
  EASY_AUTH: "easyauth",
  ANONYMOUS: "anonymous",
};

const EASY_AUTH_HEADER = "x-ms-client-principal";
const DEFAULT_ANONYMOUS_EMAIL = "anonymous@localhost";
const DEFAULT_ANONYMOUS_NAME = "Local test user";
const DEFAULT_ANONYMOUS_ORGANIZATION = "Local Test Organization";
const DEFAULT_ANONYMOUS_COLLECTION = "Local Test Videos";

function splitCsv(value) {
  return String(value || "")
    .split(/[,\n;]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

export function getAuthMode() {
  const mode = (process.env.VIPER_AUTH_MODE || AuthModes.EASY_AUTH).trim().toLowerCase();

  if (Object.values(AuthModes).includes(mode)) {
    return mode;
  }

  throw new Error(
    `Unsupported VIPER_AUTH_MODE "${process.env.VIPER_AUTH_MODE}". ` +
      `Use "${AuthModes.EASY_AUTH}" or "${AuthModes.ANONYMOUS}".`,
  );
}

export function getEasyAuthLoginUrl(callbackUrl = "/dashboard") {
  return `/.auth/login/aad?post_login_redirect_uri=${encodeURIComponent(callbackUrl)}`;
}

export function getEasyAuthLogoutUrl(callbackUrl = "/") {
  return `/.auth/logout?post_logout_redirect_uri=${encodeURIComponent(callbackUrl)}`;
}

export function getLoginUrl(callbackUrl = "/dashboard") {
  if (getAuthMode() === AuthModes.ANONYMOUS) {
    return callbackUrl;
  }

  return getEasyAuthLoginUrl(callbackUrl);
}

function claimValue(principal, claimTypes) {
  const claims = Array.isArray(principal?.claims) ? principal.claims : [];
  const normalizedClaimTypes = claimTypes.map((claimType) => claimType.toLowerCase());
  const claim = claims.find((candidate) =>
    normalizedClaimTypes.includes(String(candidate?.typ || "").toLowerCase()),
  );

  return typeof claim?.val === "string" && claim.val.trim().length
    ? claim.val.trim()
    : null;
}

function decodeEasyAuthPrincipal(encodedPrincipal) {
  if (!encodedPrincipal) {
    return null;
  }

  let decoded;
  try {
    decoded = Buffer.from(encodedPrincipal, "base64").toString("utf8");
  } catch (error) {
    throw new Error(`Invalid EasyAuth principal header: ${error.message}`);
  }

  try {
    return JSON.parse(decoded);
  } catch (error) {
    throw new Error(`Invalid EasyAuth principal JSON: ${error.message}`);
  }
}

function userFromEasyAuthHeaders(requestHeaders) {
  const principal = decodeEasyAuthPrincipal(requestHeaders.get(EASY_AUTH_HEADER));
  if (!principal) {
    return null;
  }

  const email =
    claimValue(principal, [
      "preferred_username",
      "email",
      "emails",
      "upn",
      "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
      "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn",
    ]) || principal.userDetails;

  if (!email || !String(email).includes("@")) {
    throw new Error("EasyAuth principal did not include an email-like user identifier.");
  }

  const name =
    principal.userDetails ||
    principal.name ||
    claimValue(principal, [
      "name",
      "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name",
    ]) ||
    email;

  return {
    email: String(email).trim().toLowerCase(),
    name: String(name).trim(),
  };
}

function anonymousIdentity() {
  return {
    email: (process.env.VIPER_ANONYMOUS_EMAIL || DEFAULT_ANONYMOUS_EMAIL)
      .trim()
      .toLowerCase(),
    name: (process.env.VIPER_ANONYMOUS_NAME || DEFAULT_ANONYMOUS_NAME).trim(),
  };
}

function roleForEmail(email, existingRole) {
  const adminEmails = splitCsv(process.env.VIPER_ADMIN_EMAILS);
  if (adminEmails.includes(email.toLowerCase())) {
    return Roles.ADMIN;
  }

  return existingRole || Roles.USER;
}

async function ensureAnonymousWorkspace(user) {
  if (getAuthMode() !== AuthModes.ANONYMOUS) {
    return;
  }

  const slug = (process.env.VIPER_ANONYMOUS_ORGANIZATION_SLUG || "local-test")
    .trim()
    .toLowerCase();
  const organizationName =
    process.env.VIPER_ANONYMOUS_ORGANIZATION_NAME || DEFAULT_ANONYMOUS_ORGANIZATION;
  const collectionName =
    process.env.VIPER_ANONYMOUS_COLLECTION_NAME || DEFAULT_ANONYMOUS_COLLECTION;

  const organization = await prisma.organization.upsert({
    where: { slug },
    update: {},
    create: {
      name: organizationName,
      slug,
      description: "Workspace created for explicit anonymous local testing.",
    },
  });

  await prisma.organizationMembership.upsert({
    where: {
      userId_organizationId: {
        userId: user.id,
        organizationId: organization.id,
      },
    },
    update: { role: "OWNER" },
    create: {
      userId: user.id,
      organizationId: organization.id,
      role: "OWNER",
    },
  });

  const existingCollection = await prisma.collection.findFirst({
    where: {
      organizationId: organization.id,
      name: collectionName,
    },
    select: { id: true },
  });

  const collection =
    existingCollection ||
    (await prisma.collection.create({
      data: {
        name: collectionName,
        description: "Default upload collection for anonymous local testing.",
        organizationId: organization.id,
        visibility: "PRIVATE",
      },
      select: { id: true },
    }));

  await prisma.collectionMembership.upsert({
    where: {
      collectionId_userId: {
        collectionId: collection.id,
        userId: user.id,
      },
    },
    update: { role: "OWNER" },
    create: {
      collectionId: collection.id,
      userId: user.id,
      role: "OWNER",
    },
  });
}

async function resolveIdentity() {
  const mode = getAuthMode();

  if (mode === AuthModes.ANONYMOUS) {
    return anonymousIdentity();
  }

  return userFromEasyAuthHeaders(headers());
}

export async function getCurrentUser() {
  const identity = await resolveIdentity();
  if (!identity) {
    return null;
  }

  const existingUser = await prisma.user.findUnique({
    where: { email: identity.email },
    select: { id: true, email: true, name: true, role: true },
  });
  const role = roleForEmail(identity.email, existingUser?.role);

  const user = await prisma.user.upsert({
    where: { email: identity.email },
    update: {
      name: identity.name || existingUser?.name,
      role,
    },
    create: {
      email: identity.email,
      name: identity.name,
      role,
    },
    select: { id: true, email: true, name: true, role: true },
  });

  await ensureAnonymousWorkspace(user);

  return user;
}

export async function getCurrentSession() {
  const user = await getCurrentUser();
  return user ? { user } : null;
}
