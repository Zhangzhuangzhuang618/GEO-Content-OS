import { z } from 'zod';

export const LoginFormSchema = z.object({
  csrf: z.string().min(43, '安全令牌尚未就绪，请刷新页面后重试。'),
  email: z.string().trim().email('请输入有效的邮箱地址。').max(254, '邮箱地址过长。'),
  password: z.string().min(1, '请输入密码。').max(256, '密码过长。'),
  remember_me: z.boolean(),
});

export type LoginFormValues = z.infer<typeof LoginFormSchema>;
