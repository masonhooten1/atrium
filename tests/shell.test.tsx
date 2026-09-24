// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import Home from '../src/app/page'

describe('app shell', () => {
  it('renders the Atrium shell', () => {
    render(<Home />)
    expect(screen.getByRole('heading', { name: 'Atrium' })).toBeTruthy()
  })
})
