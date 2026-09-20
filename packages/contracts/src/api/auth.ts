/** §5.4.2 Auth & profile. */
import { z } from 'zod';
import { EmailSchema, LanguageSchema, PasswordSchema, PhoneE164Schema } from '../common.js';
import { UserDtoSchema } from './shared.js';

/** FR-AUTH-01: self-registration is OWNER or DRIVER only. */
export const RegisterRequestSchema = z.object({
  role: z.enum(['OWNER', 'DRIVER']),
  name: z.string().trim().min(2).max(120),
  email: EmailSchema,
  phone: PhoneE164Schema,
  password: PasswordSchema,
  language: LanguageSchema.optional(),
  consentAccepted: z.boolean().optional(),
});
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;

/** §5.4.2: identifier is an email or a phone number. */
export const LoginRequestSchema = z.object({
  identifier: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(200),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const AuthTokensSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresIn: z.number().int(),
});
export type AuthTokens = z.infer<typeof AuthTokensSchema>;

export const AuthSessionSchema = AuthTokensSchema.extend({ user: UserDtoSchema });
export type AuthSession = z.infer<typeof AuthSessionSchema>;

export const RefreshRequestSchema = z.object({ refreshToken: z.string().min(16).max(200) });
export type RefreshRequest = z.infer<typeof RefreshRequestSchema>;

export const LogoutRequestSchema = z.object({
  refreshToken: z.string().min(16).max(200),
  pushToken: z.string().max(500).optional(),
});

/** §5.4.2 `POST /auth/guest` - only when GUEST_ENABLED=true. */
export const GuestLoginRequestSchema = z.object({}).default({});

export const ChangePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: PasswordSchema,
});

export const UpdateMeRequestSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    phone: PhoneE164Schema.optional(),
    language: z.enum(['en', 'si', 'ta']).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'No fields to update' });
export type UpdateMeRequest = z.infer<typeof UpdateMeRequestSchema>;

export const UserSettingsSchema = z.object({
  notifySecurity: z.boolean(),
  notifyInfo: z.boolean(),
  alarmSound: z.boolean(),
  theme: z.enum(['system', 'light', 'dark']),
});
export type UserSettings = z.infer<typeof UserSettingsSchema>;

export const MeResponseSchema = UserDtoSchema.extend({
  settings: UserSettingsSchema,
  hasEmergencyContact: z.boolean(),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;

export const PushTokenRequestSchema = z.object({
  token: z.string().min(8).max(500),
  platform: z.enum(['android', 'ios']),
});
