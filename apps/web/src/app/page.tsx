import { redirect } from 'next/navigation';

export default function HomePage(): never {
  redirect('/auth-01');
}
