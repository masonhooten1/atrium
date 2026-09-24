import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Atrium',
  description:
    'Meetings-first world prototype — one persistent street, the meeting continuum, and the pod gesture.',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en">
      <body className="bg-slate-950 text-slate-100 antialiased">{children}</body>
    </html>
  )
}
