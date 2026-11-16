import type React from 'react'
import { letterAvatarColor, letterAvatarLetter } from '../../../shared/letter-avatar'
import { cn } from '@/lib/utils'

// Why: local identity badge so agent/app icons never hit a remote favicon service (U122).
export function LetterAvatar({
  name,
  size = 14,
  className
}: {
  name: string
  size?: number
  className?: string
}): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      className={cn('shrink-0', className)}
    >
      <rect width="14" height="14" rx="3" fill={letterAvatarColor(name)} />
      <text
        x="7"
        y="10.5"
        textAnchor="middle"
        fontSize="8.5"
        fill="#fff"
        fontWeight="700"
        fontFamily="system-ui, -apple-system, sans-serif"
      >
        {letterAvatarLetter(name)}
      </text>
    </svg>
  )
}
