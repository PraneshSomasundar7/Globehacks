import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useAuth } from '../context/AuthContext'
import { insforge } from '../lib/insforge'
import {
  Home, Search, Bell, LogOut, MapPin, Bed, Bath, Maximize,
  Heart, Eye, Sparkles, Send, SlidersHorizontal,
  X, CheckCircle2, Bot, Loader2, UserCircle, MessageSquare,
  TrendingUp, Activity, Mail, ChevronDown,
} from 'lucide-react'

// ── Helpers ──────────────────────────────────────────────────────────────────

const TAGS = [
  { label: 'Just Listed', color: '#3B82F6' },
  { label: 'Open House', color: '#10B981' },
  { label: 'Coming Soon', color: '#F59E0B' },
  { label: 'New', color: '#06B6D4' },
  { label: 'Price Drop', color: '#EF4444' },
]

function getTag(property, idx) {
  if (property.price >= 1_000_000) return { label: 'Luxury', color: '#8B5CF6' }
  return TAGS[idx % TAGS.length]
}

function formatPrice(price) {
  if (price >= 1_000_000) return `$${(price / 1_000_000).toFixed(1)}M`
  return `$${price.toLocaleString('en-US')}`
}

function parseSpecs(specs = '') {
  const bed = specs.match(/(\d+(?:\.\d+)?)\s*bed/i)?.[1] ?? '—'
  const bath = specs.match(/(\d+(?:\.\d+)?)\s*bath/i)?.[1] ?? '—'
  const sqft = specs.match(/([\d,]+)\s*sqft/i)?.[1] ?? '—'
  return { bed, bath, sqft }
}

const AGENT_COLORS = {
  'agent1@gmail.com': { bg: '#EFF6FF', text: '#1D4ED8', border: '#BFDBFE' },
  'agent2@gmail.com': { bg: '#FDF4FF', text: '#7E22CE', border: '#E9D5FF' },
  'agent3@gmail.com': { bg: '#F0FDF4', text: '#15803D', border: '#BBF7D0' },
}

function timeAgo(date) {
  const secs = Math.floor((Date.now() - new Date(date)) / 1000)
  if (secs < 60) return 'Just now'
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
  return `${Math.floor(secs / 3600)}h ago`
}

function SkeletonCard() {
  return (
    <div className="rounded-2xl overflow-hidden animate-pulse"
      style={{ background: 'white', border: '1px solid #F1F3F5' }}>
      <div className="h-48 bg-gray-100" />
      <div className="p-4 flex flex-col gap-2">
        <div className="h-3.5 w-3/4 rounded bg-gray-100" />
        <div className="h-3 w-1/2 rounded bg-gray-100" />
        <div className="h-3 w-full rounded bg-gray-100 mt-1" />
      </div>
    </div>
  )
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function UserPortal() {
  const { user, logout } = useAuth()

  const [properties, setProperties] = useState([])
  const [loadingProps, setLoadingProps] = useState(true)

  // Per-property lead tracking: { [property_title]: { id, lead_score, view_count } }
  const propertyLeadsRef = useRef({})
  const [propertyLeads, setPropertyLeads] = useState({})

  const updatePropertyLead = useCallback((title, data) => {
    propertyLeadsRef.current = { ...propertyLeadsRef.current, [title]: data }
    setPropertyLeads(prev => ({ ...prev, [title]: data }))
  }, [])

  const [searchQuery, setSearchQuery] = useState('')
  const [sortBy, setSortBy] = useState('Recommended')
  const [favorites, setFavorites] = useState(new Set())
  const [selectedListing, setSelectedListing] = useState(null)
  const [lastLikedTitle, setLastLikedTitle] = useState(null)
  const [aiDismissed, setAiDismissed] = useState(false)
  const [aiSending, setAiSending] = useState(false)
  const [aiSent, setAiSent] = useState(false)

  const [incomingMsg, setIncomingMsg] = useState(null)
  const [msgDismissed, setMsgDismissed] = useState(false)
  const [msgAccepted, setMsgAccepted] = useState(false)
  const [msgAccepting, setMsgAccepting] = useState(false)
  const lastMsgIdRef = useRef(null)

  // All messages for this buyer (inbox)
  const [allMessages, setAllMessages] = useState([])
  const [acceptingMsgId, setAcceptingMsgId] = useState(null)
  const [acceptedMsgIds, setAcceptedMsgIds] = useState(new Set())
  const unreadCount = allMessages.filter(m => m.from_email !== user?.email && !acceptedMsgIds.has(m.id)).length

  const [activeTab, setActiveTab] = useState('browse')
  const [latestActivityTitle, setLatestActivityTitle] = useState(null)

  const firstName = user?.full_name?.split(' ')[0] || 'there'
  const totalScore = useMemo(
    () => Object.values(propertyLeads).reduce((s, l) => s + (l.lead_score || 0), 0),
    [propertyLeads]
  )

  // ── Fetch properties + load existing leads ────────────────────────────────
  useEffect(() => {
    if (!user) return
    let cancelled = false

    async function init() {
      const { data: propsData } = await insforge.database
        .from('PropertyDetails')
        .select('*')
        .order('price', { ascending: true })

      if (!cancelled && propsData) setProperties(propsData)
      if (!cancelled) setLoadingProps(false)

      const { data: existingLeads } = await insforge.database
        .from('leads')
        .select('id, property_title, lead_score, view_count, last_activity')
        .eq('email', user.email)

      if (!cancelled && existingLeads?.length) {
        const map = {}
        existingLeads.forEach(l => {
          if (l.property_title) map[l.property_title] = { id: l.id, lead_score: l.lead_score ?? 0, view_count: l.view_count ?? 0, last_activity: l.last_activity ?? null }
        })
        propertyLeadsRef.current = map
        setPropertyLeads(map)
      }
    }

    init()
    return () => { cancelled = true }
  }, [user])

  // ── Listen for incoming messages from agent (polling + realtime hybrid) ─────
  useEffect(() => {
    if (!user?.email) return
    let active = true

    // Core fetch: get the latest unaccepted message addressed to this buyer
    async function fetchLatestMessage() {
      try {
        const { data } = await insforge.database
          .from('messages')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(20)
        if (!active || !data?.length) return

        // Find the newest message that isn't from the buyer and isn't accepted locally
        const msg = data.find(m => m.from_email !== user.email && !acceptedMsgIds.has(m.id))
        if (!msg) return

        // Only surface if it's truly new (different id from what we last saw)
        if (msg.id !== lastMsgIdRef.current) {
          lastMsgIdRef.current = msg.id
          setIncomingMsg(msg)
          setMsgDismissed(false)
          setMsgAccepted(false)
        }
      } catch { /* silent */ }
    }

    // Fire immediately, then poll every 3 s
    fetchLatestMessage()
    const interval = setInterval(fetchLatestMessage, 3000)

    // Also wire up realtime as a fast-path on top
    async function setupRealtime() {
      try {
        await insforge.realtime.connect()
        await insforge.realtime.subscribe('messages')
        insforge.realtime.on('NEW_message', (payload) => {
          if (!active) return
          // Skip if it's a message we sent or if we've already accepted it
          if (payload.from_email === user.email || acceptedMsgIds.has(payload.id)) return
          lastMsgIdRef.current = payload.id
          setIncomingMsg(payload)
          setMsgDismissed(false)
          setMsgAccepted(false)
        })
      } catch { /* realtime unavailable — polling covers it */ }
    }
    setupRealtime()

    return () => {
      active = false
      clearInterval(interval)
      try { insforge.realtime.unsubscribe('messages') } catch { }
    }
  }, [user?.email])

  // ── Accept incoming message: mark accepted + notify agent ────────────────
  const handleAcceptMessage = useCallback(async () => {
    if (!incomingMsg || !user) return
    setMsgAccepting(true)
    try {
      await insforge.database.from('messages').insert([{
        from_email: user.email,
        from_name: user.full_name,
        to_email: incomingMsg.from_email,
        content: `Hi ${incomingMsg.from_name?.split(' ')[0] || 'there'}! I'd love to schedule a showing. Looking forward to it! — ${user.full_name?.split(' ')[0] || user.full_name}`,
        property_title: incomingMsg.property_title,
      }])
      setAcceptedMsgIds(prev => new Set([...prev, incomingMsg.id]))
    } catch { /* silent */ }
    setMsgAccepting(false)
    setMsgAccepted(true)
  }, [incomingMsg, user])

  // ── Per-message accept (used from inbox tab) ───────────────────────────────
  const handleAcceptMsg = useCallback(async (msg) => {
    if (!user || acceptingMsgId === msg.id) return
    setAcceptingMsgId(msg.id)
    try {
      await insforge.database.from('messages').insert([{
        from_email: user.email,
        from_name: user.full_name,
        to_email: msg.from_email,
        content: `Hi ${msg.from_name?.split(' ')[0] || 'there'}! I'd love to schedule a showing. Looking forward to it! — ${user.full_name?.split(' ')[0] || user.full_name}`,
        property_title: msg.property_title,
      }])
      setAcceptedMsgIds(prev => new Set([...prev, msg.id]))
      // Also update allMessages to reflect accepted state immediately
      setAllMessages(prev => prev.map(m => m.id === msg.id ? { ...m, accepted: true } : m))
      // Keep banner in sync if this was the banner message
      if (incomingMsg?.id === msg.id) setMsgAccepted(true)
    } catch { /* silent */ }
    setAcceptingMsgId(null)
  }, [user, acceptingMsgId, incomingMsg])

  // ── Fetch ALL messages for inbox tab ────────────────────────────────────
  useEffect(() => {
    if (!user?.email) return
    let active = true
    async function fetchAllMessages() {
      try {
        const { data } = await insforge.database
          .from('messages')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(50)
        if (!active || !data) return
        // Filter out messages we sent (so inbox only shows agent->buyer messages)
        setAllMessages(data.filter(m => m.from_email !== user.email))
      } catch { /* silent */ }
    }
    fetchAllMessages()
    const interval = setInterval(fetchAllMessages, 3000)
    return () => { active = false; clearInterval(interval) }
  }, [user?.email])

  // ── Per-property interaction handler ──────────────────────────────────────
  const handlePropertyInteraction = useCallback(async (propertyTitle, agentEmail, agentName, actionType) => {
    if (!user) return
    const scoreIncrease = actionType === 'like' ? 15 : 5
    const cached = propertyLeadsRef.current[propertyTitle]

    const now = new Date().toISOString()
    if (cached?.id) {
      const newScore = (cached.lead_score || 0) + scoreIncrease
      const newViews = actionType === 'view' ? (cached.view_count || 0) + 1 : (cached.view_count || 0)
      updatePropertyLead(propertyTitle, { ...cached, lead_score: newScore, view_count: newViews, last_activity: now })
      setLatestActivityTitle(propertyTitle)
      await insforge.database
        .from('leads')
        .update({ lead_score: newScore, view_count: newViews, status: 'active', last_activity: now })
        .eq('id', cached.id)
    } else {
      const initScore = scoreIncrease
      const initViews = actionType === 'view' ? 1 : 0
      updatePropertyLead(propertyTitle, { id: null, lead_score: initScore, view_count: initViews, last_activity: now })
      setLatestActivityTitle(propertyTitle)
      const { data: created } = await insforge.database
        .from('leads')
        .insert([{
          name: user.full_name,
          email: user.email,
          property_title: propertyTitle,
          agent_email: agentEmail,
          agent_name: agentName,
          lead_score: initScore,
          view_count: initViews,
          status: 'active',
          last_activity: now,
        }])
        .select('id, lead_score, view_count')
      if (created?.[0]) updatePropertyLead(propertyTitle, { ...created[0], last_activity: now })
    }
  }, [user, updatePropertyLead])

  // ── Favorites toggle ──────────────────────────────────────────────────────
  const toggleFavorite = useCallback((propertyId, property, e) => {
    e?.stopPropagation()
    setFavorites(prev => {
      const next = new Set(prev)
      if (next.has(propertyId)) {
        next.delete(propertyId)
      } else {
        next.add(propertyId)
        setLastLikedTitle(property.title)
        setLatestActivityTitle(property.title)
        setAiDismissed(false)
        setAiSent(false)
        handlePropertyInteraction(property.title, property.agent_email, property.agent_name, 'like')
      }
      return next
    })
  }, [handlePropertyInteraction])

  const handleCardClick = useCallback((listing) => {
    setSelectedListing(listing)
    handlePropertyInteraction(listing.title, listing.agent_email, listing.agent_name, 'view')
  }, [handlePropertyInteraction])

  const handleAiNotify = () => {
    setAiSending(true)
    setTimeout(() => { setAiSending(false); setAiSent(true) }, 1500)
  }

  const activityList = useMemo(() => {
    return Object.entries(propertyLeads)
      .map(([title, data]) => {
        const property = properties.find(p => p.title === title)
        if (!property) return null
        return { ...data, propertyTitle: title, property, liked: favorites.has(property.id) }
      })
      .filter(Boolean)
      .sort((a, b) => {
        if (a.last_activity && b.last_activity)
          return new Date(b.last_activity) - new Date(a.last_activity)
        return (b.lead_score || 0) - (a.lead_score || 0)
      })
  }, [propertyLeads, properties, favorites])

  useEffect(() => {
    if (!latestActivityTitle) return
    const t = setTimeout(() => setLatestActivityTitle(null), 800)
    return () => clearTimeout(t)
  }, [latestActivityTitle])

  const displayedProperties = useMemo(() => {
    const q = searchQuery.toLowerCase()
    const filtered = properties.filter(p =>
      p.title?.toLowerCase().includes(q) || p.location?.toLowerCase().includes(q) ||
      p.agent_name?.toLowerCase().includes(q)
    )
    if (sortBy === 'Price: Low to High') return [...filtered].sort((a, b) => a.price - b.price)
    if (sortBy === 'Price: High to Low') return [...filtered].sort((a, b) => b.price - a.price)
    if (sortBy === 'Agent') return [...filtered].sort((a, b) => (a.agent_name || '').localeCompare(b.agent_name || ''))
    return filtered
  }, [properties, searchQuery, sortBy])

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen" style={{ background: '#F8F9FB' }}>

      {/* ── Top Nav ── */}
      <header className="sticky top-0 z-50"
        style={{ background: 'white', borderBottom: '1px solid #E5E7EB', boxShadow: '0 1px 3px rgba(0,0,0,0.03)' }}>
        <div className="flex items-center justify-between px-6 py-0 max-w-[1280px] mx-auto">
          <div className="flex items-center gap-2.5 py-3.5">
            <div className="w-8 h-8 rounded-xl flex items-center justify-center"
              style={{ background: 'linear-gradient(135deg, #3B82F6, #1D4ED8)', boxShadow: '0 2px 8px rgba(59,130,246,0.35)' }}>
              <Home size={16} color="white" strokeWidth={2.5} />
            </div>
            <span className="text-lg font-bold tracking-tight text-gray-800">Lofty</span>
            <span className="text-xs font-semibold px-2 py-0.5 rounded-md"
              style={{ background: 'linear-gradient(135deg, #EEF2FF, #DBEAFE)', color: '#3B82F6', border: '1px solid #BFDBFE' }}>
              PORTAL
            </span>
          </div>

          <div className="flex items-center gap-3">
            {totalScore > 0 && (
              <div className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-xl"
                style={{ background: totalScore >= 70 ? '#FEF3C7' : '#F0FDF4', border: `1px solid ${totalScore >= 70 ? '#FCD34D' : '#BBF7D0'}` }}>
                <span className="text-xs font-bold" style={{ color: totalScore >= 70 ? '#B45309' : '#16A34A' }}>
                  Interest Score {totalScore}
                </span>
              </div>
            )}
            <button className="w-9 h-9 rounded-xl flex items-center justify-center hover:bg-gray-100 transition-colors relative"
              style={{ border: '1px solid #E5E7EB' }}>
              <Bell size={16} color="#64748B" />
              <span className="absolute -top-0.5 -right-0.5 w-3 h-3 rounded-full" style={{ background: '#EF4444', border: '2px solid white' }} />
            </button>
            <div className="flex items-center gap-2 pl-3" style={{ borderLeft: '1px solid #E5E7EB' }}>
              <div className="w-9 h-9 rounded-xl flex items-center justify-center text-xs font-bold"
                style={{ background: 'linear-gradient(135deg, #8B5CF6, #6D28D9)', color: 'white' }}>
                {user?.full_name?.split(' ').map(n => n[0]).join('').slice(0, 2) || 'U'}
              </div>
              <div className="hidden sm:block">
                <p className="text-sm font-semibold text-gray-700">{user?.full_name}</p>
                <p className="text-xs text-gray-400">Home Buyer</p>
              </div>
              <button onClick={logout}
                className="ml-2 w-8 h-8 rounded-lg flex items-center justify-center hover:bg-red-50 transition-colors cursor-pointer bg-transparent border-none"
                title="Sign Out">
                <LogOut size={15} color="#EF4444" />
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-[1280px] mx-auto px-6 pb-12">

        {/* ── Welcome + Search ── */}
        <div className="mt-8 mb-6">
          <h1 className="text-2xl font-bold text-gray-800 mb-1">Welcome back, {firstName}</h1>
          <p className="text-sm text-gray-500 mb-5">Browse listings and connect with your dedicated agent.</p>

          <div className="flex gap-3">
            <div className="flex-1 relative">
              <Search size={18} className="absolute left-4 top-1/2 -translate-y-1/2" color="#94A3B8" />
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Search by city, title, or agent name..."
                className="w-full pl-11 pr-4 py-3.5 rounded-xl text-sm outline-none transition-all"
                style={{ border: '1px solid #E2E8F0', background: 'white', color: '#1E293B', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}
                onFocus={e => (e.target.style.borderColor = '#3B82F6')}
                onBlur={e => (e.target.style.borderColor = '#E2E8F0')}
              />
            </div>
            <button className="flex items-center gap-2 px-5 py-3 rounded-xl text-sm font-medium cursor-pointer transition-all hover:bg-gray-50"
              style={{ background: 'white', color: '#475569', border: '1px solid #E2E8F0' }}>
              <SlidersHorizontal size={16} /> Filters
            </button>
          </div>
        </div>

        {/* ── AI Assistant Widget ── */}
        {!aiDismissed && lastLikedTitle && (
          <div className="rounded-2xl p-5 mb-6 relative overflow-hidden"
            style={{ background: 'linear-gradient(135deg, #EFF6FF 0%, #F5F3FF 50%, #F0FDFA 100%)', border: '1px solid #C7D2FE' }}>
            <button onClick={() => setAiDismissed(true)}
              className="absolute top-3 right-3 w-7 h-7 rounded-lg flex items-center justify-center bg-transparent border-none cursor-pointer hover:bg-white/60">
              <X size={14} color="#94A3B8" />
            </button>
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 rounded-2xl flex items-center justify-center shrink-0"
                style={{ background: 'linear-gradient(135deg, #6366F1, #8B5CF6)', boxShadow: '0 4px 12px rgba(99,102,241,0.3)' }}>
                <Bot size={24} color="white" />
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <p className="text-sm font-bold text-gray-800">Lofty AI Assistant</p>
                  <span className="text-xs font-semibold px-2 py-0.5 rounded-full flex items-center gap-1"
                    style={{ background: '#EEF2FF', color: '#6366F1', border: '1px solid #C7D2FE' }}>
                    <Sparkles size={10} /> AI
                  </span>
                </div>
                {aiSent ? (
                  <div className="flex items-center gap-2 mt-2">
                    <CheckCircle2 size={18} color="#10B981" />
                    <p className="text-sm text-gray-600">Done! Your agent has been notified and will reach out shortly.</p>
                  </div>
                ) : (
                  <>
                    <p className="text-sm text-gray-600 leading-relaxed">
                      Hi {firstName}! I noticed you liked <strong className="text-gray-800">{lastLikedTitle}</strong>. Would you like me to notify your agent to schedule a private showing?
                    </p>
                    <div className="flex items-center gap-2.5 mt-3">
                      <button onClick={handleAiNotify} disabled={aiSending}
                        className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white border-none cursor-pointer disabled:opacity-70"
                        style={{ background: 'linear-gradient(135deg, #6366F1, #7C3AED)', boxShadow: '0 2px 8px rgba(99,102,241,0.35)' }}>
                        {aiSending ? <><Loader2 size={14} className="animate-spin" /> Notifying...</> : <><Send size={14} /> Yes, notify my agent!</>}
                      </button>
                      <button onClick={() => setAiDismissed(true)}
                        className="px-4 py-2 rounded-xl text-sm font-medium bg-transparent border-none cursor-pointer" style={{ color: '#94A3B8' }}>
                        Maybe later
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── Incoming Agent Message Notification ── */}
        {incomingMsg && !msgDismissed && (
          <div className="rounded-2xl p-5 mb-6 relative overflow-hidden"
            style={{
              background: msgAccepted
                ? 'linear-gradient(135deg, #F0FDF4 0%, #ECFDF5 100%)'
                : 'linear-gradient(135deg, #EFF6FF 0%, #F0FDF4 100%)',
              border: msgAccepted ? '1px solid #6EE7B7' : '1px solid #93C5FD',
              boxShadow: msgAccepted
                ? '0 4px 20px rgba(16,185,129,0.15)'
                : '0 4px 20px rgba(59,130,246,0.15)',
            }}>
            <button onClick={() => setMsgDismissed(true)}
              className="absolute top-3 right-3 w-7 h-7 rounded-lg flex items-center justify-center bg-transparent border-none cursor-pointer hover:bg-white/60">
              <X size={14} color="#94A3B8" />
            </button>

            {/* Header */}
            <div className="flex items-center gap-2 mb-3">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
                style={{
                  background: msgAccepted
                    ? 'linear-gradient(135deg, #10B981, #059669)'
                    : 'linear-gradient(135deg, #3B82F6, #1D4ED8)',
                  boxShadow: msgAccepted
                    ? '0 3px 10px rgba(16,185,129,0.35)'
                    : '0 3px 10px rgba(59,130,246,0.35)',
                }}>
                {msgAccepted
                  ? <CheckCircle2 size={20} color="white" />
                  : <MessageSquare size={20} color="white" />}
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-sm font-bold text-gray-800">
                    {msgAccepted ? '✅ Showing Accepted!' : `📩 New message from ${incomingMsg.from_name || 'Your Agent'}`}
                  </p>
                  <span className="text-xs font-semibold px-2 py-0.5 rounded-full flex items-center gap-1"
                    style={{
                      background: msgAccepted ? '#D1FAE5' : '#DBEAFE',
                      color: msgAccepted ? '#065F46' : '#1D4ED8',
                      border: msgAccepted ? '1px solid #6EE7B7' : '1px solid #93C5FD',
                    }}>
                    <Sparkles size={9} />
                    {msgAccepted ? 'Response Sent' : 'Your Agent'}
                  </span>
                </div>
                {incomingMsg.property_title && (
                  <p className="text-xs text-gray-400 mt-0.5 flex items-center gap-1">
                    <Home size={10} /> Re: {incomingMsg.property_title}
                  </p>
                )}
              </div>
            </div>

            {/* Message bubble */}
            <div className="rounded-xl p-4 mb-4"
              style={{
                background: 'white',
                border: `1px solid ${msgAccepted ? '#A7F3D0' : '#BFDBFE'}`,
                boxShadow: '0 1px 4px rgba(0,0,0,0.05)',
              }}>
              <p className="text-xs font-semibold mb-1.5 flex items-center gap-1.5"
                style={{ color: msgAccepted ? '#059669' : '#2563EB' }}>
                <MessageSquare size={11} />
                {msgAccepted ? 'Agent\'s message' : 'Message from your agent'}
              </p>
              <p className="text-sm text-gray-700 leading-relaxed">
                "{incomingMsg.content}"
              </p>
            </div>

            {/* Action area */}
            {msgAccepted ? (
              <div className="flex items-center gap-2">
                <CheckCircle2 size={16} color="#10B981" />
                <p className="text-sm text-gray-600">
                  Your agent <strong>{incomingMsg.from_name}</strong> has been notified. They'll reach out to confirm the time.
                </p>
              </div>
            ) : (
              <div className="flex items-center gap-2.5">
                <button
                  onClick={handleAcceptMessage}
                  disabled={msgAccepting}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold text-white border-none cursor-pointer disabled:opacity-70 disabled:cursor-not-allowed"
                  style={{
                    background: msgAccepting ? '#059669' : 'linear-gradient(135deg, #10B981, #059669)',
                    boxShadow: '0 2px 8px rgba(16,185,129,0.4)',
                    transition: 'all 0.2s',
                  }}
                >
                  {msgAccepting
                    ? <><Loader2 size={14} className="animate-spin" /> Accepting..{'>'}</>
                    : <><CheckCircle2 size={14} /> Accept Showing</>}
                </button>
                <button
                  onClick={() => setMsgDismissed(true)}
                  className="px-4 py-2.5 rounded-xl text-sm font-medium bg-transparent border-none cursor-pointer"
                  style={{ color: '#94A3B8' }}
                >
                  Maybe later
                </button>
              </div>
            )}
          </div>
        )}

        {/* ── Tab Switcher ── */}
        <div className="flex items-center gap-1 p-1 rounded-2xl mb-5 w-fit"
          style={{ background: '#F1F5F9' }}>
          <button onClick={() => setActiveTab('browse')}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold border-none cursor-pointer transition-all"
            style={{
              background: activeTab === 'browse' ? 'white' : 'transparent',
              color: activeTab === 'browse' ? '#1E293B' : '#64748B',
              boxShadow: activeTab === 'browse' ? '0 1px 4px rgba(0,0,0,0.08)' : 'none',
            }}>
            <Home size={14} /> Browse Listings
          </button>
          <button onClick={() => setActiveTab('activity')}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold border-none cursor-pointer transition-all"
            style={{
              background: activeTab === 'activity' ? 'white' : 'transparent',
              color: activeTab === 'activity' ? '#1E293B' : '#64748B',
              boxShadow: activeTab === 'activity' ? '0 1px 4px rgba(0,0,0,0.08)' : 'none',
            }}>
            <Activity size={14} /> My Activity
            {activityList.length > 0 && (
              <span className="flex items-center justify-center w-5 h-5 rounded-full text-xs font-bold text-white"
                style={{ background: '#3B82F6' }}>
                {activityList.length}
              </span>
            )}
          </button>
          <button onClick={() => setActiveTab('messages')}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold border-none cursor-pointer transition-all"
            style={{
              background: activeTab === 'messages' ? 'white' : 'transparent',
              color: activeTab === 'messages' ? '#1E293B' : '#64748B',
              boxShadow: activeTab === 'messages' ? '0 1px 4px rgba(0,0,0,0.08)' : 'none',
            }}>
            <Mail size={14} /> Messages
            {unreadCount > 0 && (
              <span className="flex items-center justify-center w-5 h-5 rounded-full text-xs font-bold text-white"
                style={{ background: '#EF4444' }}>
                {unreadCount}
              </span>
            )}
          </button>
        </div>

        {/* ── Messages Tab ── */}
        {activeTab === 'messages' && (
          <div>
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-lg font-bold text-gray-800">Messages</h2>
                <p className="text-xs text-gray-400 mt-0.5">
                  {allMessages.length === 0 ? 'No messages yet' : `${allMessages.length} message${allMessages.length !== 1 ? 's' : ''} from your agent`}
                </p>
              </div>
              {unreadCount > 0 && (
                <span className="text-xs font-semibold px-3 py-1.5 rounded-xl"
                  style={{ background: '#FEF2F2', color: '#DC2626', border: '1px solid #FECACA' }}>
                  {unreadCount} unread
                </span>
              )}
            </div>

            {allMessages.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 rounded-2xl"
                style={{ background: 'white', border: '1px solid #F1F3F5' }}>
                <div className="w-14 h-14 rounded-2xl flex items-center justify-center mb-3"
                  style={{ background: 'linear-gradient(135deg, #EFF6FF, #DBEAFE)' }}>
                  <Mail size={28} color="#3B82F6" />
                </div>
                <p className="text-sm font-semibold text-gray-600">No messages yet</p>
                <p className="text-xs text-gray-400 mt-1 text-center max-w-xs">
                  When your agent sends you a message, it will appear here.
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                {allMessages.map(msg => {
                  const isAccepted = acceptedMsgIds.has(msg.id)
                  const isAccepting = acceptingMsgId === msg.id
                  return (
                    <div key={msg.id}
                      className="rounded-2xl p-5 transition-shadow hover:shadow-md"
                      style={{
                        background: isAccepted
                          ? 'linear-gradient(135deg, #F0FDF4, #ECFDF5)'
                          : 'white',
                        border: isAccepted ? '1px solid #A7F3D0' : '1px solid #E5E7EB',
                        boxShadow: '0 1px 4px rgba(0,0,0,0.05)',
                      }}>

                      {/* Message header */}
                      <div className="flex items-start justify-between gap-3 mb-3">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 text-sm font-bold text-white"
                            style={{ background: isAccepted ? 'linear-gradient(135deg,#10B981,#059669)' : 'linear-gradient(135deg,#3B82F6,#1D4ED8)' }}>
                            {msg.from_name?.split(' ').map(n => n[0]).join('').slice(0, 2) || 'AG'}
                          </div>
                          <div>
                            <p className="text-sm font-bold text-gray-800">{msg.from_name || 'Your Agent'}</p>
                            <p className="text-xs text-gray-400">Your Agent</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {isAccepted ? (
                            <span className="flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full"
                              style={{ background: '#D1FAE5', color: '#065F46', border: '1px solid #6EE7B7' }}>
                              <CheckCircle2 size={11} /> Accepted
                            </span>
                          ) : (
                            <span className="flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full"
                              style={{ background: '#EFF6FF', color: '#1D4ED8', border: '1px solid #BFDBFE' }}>
                              <Mail size={11} /> New
                            </span>
                          )}
                          {msg.created_at && (
                            <span className="text-xs text-gray-400">{timeAgo(msg.created_at)}</span>
                          )}
                        </div>
                      </div>

                      {/* Property tag */}
                      {msg.property_title && (
                        <div className="flex items-center gap-1.5 mb-3">
                          <Home size={12} color="#94A3B8" />
                          <span className="text-xs font-medium text-gray-500">Re: {msg.property_title}</span>
                        </div>
                      )}

                      {/* Message content bubble */}
                      <div className="rounded-xl p-4 mb-4"
                        style={{
                          background: isAccepted ? 'rgba(255,255,255,0.7)' : '#F8FAFC',
                          border: isAccepted ? '1px solid #D1FAE5' : '1px solid #E2E8F0',
                        }}>
                        <p className="text-xs font-semibold mb-2 flex items-center gap-1.5"
                          style={{ color: isAccepted ? '#059669' : '#64748B' }}>
                          <MessageSquare size={11} /> Message
                        </p>
                        <p className="text-sm text-gray-700 leading-relaxed">
                          "{msg.content}"
                        </p>
                      </div>

                      {/* Action */}
                      {!isAccepted && (
                        <button
                          onClick={() => handleAcceptMsg(msg)}
                          disabled={isAccepting}
                          className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold text-white border-none cursor-pointer disabled:opacity-70 disabled:cursor-not-allowed"
                          style={{
                            background: 'linear-gradient(135deg, #10B981, #059669)',
                            boxShadow: '0 2px 8px rgba(16,185,129,0.35)',
                          }}
                        >
                          {isAccepting
                            ? <><Loader2 size={14} className="animate-spin" /> Accepting...</>
                            : <><CheckCircle2 size={14} /> Accept Showing</>}
                        </button>
                      )}
                      {isAccepted && (
                        <p className="text-xs text-emerald-600 flex items-center gap-1.5 font-medium">
                          <CheckCircle2 size={13} color="#059669" />
                          You accepted this showing — your agent has been notified.
                        </p>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* ── Browse Tab ── */}
        {activeTab === 'browse' && (
          <>
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-lg font-bold text-gray-800">Featured Listings</h2>
                <p className="text-xs text-gray-400 mt-0.5">
                  {loadingProps ? 'Loading...' : `${displayedProperties.length} properties from 3 agents`}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-400">Sort by:</span>
                <select value={sortBy} onChange={e => setSortBy(e.target.value)}
                  className="text-sm font-medium px-3 py-1.5 rounded-lg cursor-pointer outline-none"
                  style={{ border: '1px solid #E2E8F0', background: 'white', color: '#475569' }}>
                  <option>Recommended</option>
                  <option>Price: Low to High</option>
                  <option>Price: High to Low</option>
                  <option>Agent</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
              {loadingProps
                ? Array.from({ length: 6 }).map((_, i) => <SkeletonCard key={i} />)
                : displayedProperties.map((listing, idx) => {
                  const { bed, bath, sqft } = parseSpecs(listing.specs)
                  const tag = getTag(listing, idx)
                  const liked = favorites.has(listing.id)
                  const leadData = propertyLeads[listing.title]
                  const viewCount = leadData?.view_count ?? 0
                  const agentColor = AGENT_COLORS[listing.agent_email] || { bg: '#F8FAFC', text: '#64748B', border: '#E2E8F0' }
                  return (
                    <div key={listing.id}
                      className="rounded-2xl overflow-hidden cursor-pointer group"
                      style={{
                        background: 'white', border: '1px solid #F1F3F5',
                        boxShadow: '0 1px 3px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.02)',
                        transition: 'transform 0.2s ease, box-shadow 0.2s ease',
                      }}
                      onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-3px)'; e.currentTarget.style.boxShadow = '0 8px 24px rgba(0,0,0,0.10)' }}
                      onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = '0 1px 3px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.02)' }}
                      onClick={() => handleCardClick(listing)}
                    >
                      <div className="relative h-48 overflow-hidden">
                        <img src={listing.image_url} alt={listing.title}
                          className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" loading="lazy" />
                        <div className="absolute inset-0" style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.32) 0%, transparent 55%)' }} />
                        <span className="absolute top-3 left-3 text-xs font-bold px-2.5 py-1 rounded-lg text-white"
                          style={{ background: tag.color, boxShadow: '0 2px 6px rgba(0,0,0,0.15)' }}>{tag.label}</span>
                        <button onClick={e => toggleFavorite(listing.id, listing, e)}
                          className="absolute top-3 right-3 w-9 h-9 rounded-xl flex items-center justify-center bg-white/80 backdrop-blur border-none cursor-pointer"
                          style={{ transition: 'transform 0.15s ease' }}
                          onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.15)'; e.currentTarget.style.background = 'white' }}
                          onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; e.currentTarget.style.background = 'rgba(255,255,255,0.8)' }}>
                          <Heart size={18} color={liked ? '#EF4444' : '#94A3B8'} fill={liked ? '#EF4444' : 'none'}
                            style={{ transition: 'color 0.2s, fill 0.2s' }} />
                        </button>
                        <div className="absolute bottom-3 left-3">
                          <p className="text-xl font-bold text-white" style={{ textShadow: '0 1px 4px rgba(0,0,0,0.3)' }}>
                            {formatPrice(listing.price)}
                          </p>
                        </div>
                        {viewCount > 0 && (
                          <div className="absolute bottom-3 right-3 flex items-center gap-1 px-2 py-1 rounded-lg text-white text-xs font-semibold"
                            style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)' }}>
                            <Eye size={11} /> {viewCount}
                          </div>
                        )}
                      </div>
                      <div className="p-4">
                        <p className="text-sm font-semibold text-gray-800 truncate">{listing.title}</p>
                        <p className="text-xs text-gray-400 mt-0.5 flex items-center gap-1"><MapPin size={11} /> {listing.location}</p>
                        {listing.agent_name && (
                          <div className="mt-2 flex items-center gap-1.5 w-fit px-2.5 py-1 rounded-lg"
                            style={{ background: agentColor.bg, border: `1px solid ${agentColor.border}` }}>
                            <UserCircle size={12} color={agentColor.text} />
                            <span className="text-xs font-medium" style={{ color: agentColor.text }}>{listing.agent_name}</span>
                          </div>
                        )}
                        <div className="flex items-center gap-4 mt-3 pt-3" style={{ borderTop: '1px solid #F1F3F5' }}>
                          <span className="text-xs text-gray-500 flex items-center gap-1"><Bed size={13} color="#94A3B8" /> {bed} Beds</span>
                          <span className="text-xs text-gray-500 flex items-center gap-1"><Bath size={13} color="#94A3B8" /> {bath} Baths</span>
                          <span className="text-xs text-gray-500 flex items-center gap-1"><Maximize size={13} color="#94A3B8" /> {sqft} sqft</span>
                        </div>
                      </div>
                    </div>
                  )
                })
              }
            </div>

            {!loadingProps && displayedProperties.length === 0 && (
              <div className="text-center py-16">
                <Search size={40} color="#D1D5DB" className="mx-auto mb-3" />
                <p className="text-gray-400 text-sm">No properties found for "{searchQuery}"</p>
              </div>
            )}
          </>
        )}

        {/* ── Activity Tab ── */}
        {activeTab === 'activity' && (
          <div>
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-lg font-bold text-gray-800">My Activity</h2>
                <p className="text-xs text-gray-400 mt-0.5">
                  {activityList.length === 0
                    ? 'No interactions yet'
                    : `${activityList.length} propert${activityList.length !== 1 ? 'ies' : 'y'} interacted`}
                </p>
              </div>
            </div>

            {activityList.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 rounded-2xl"
                style={{ background: 'white', border: '1px solid #F1F3F5' }}>
                <Activity size={40} color="#D1D5DB" className="mb-3" />
                <p className="text-sm font-medium text-gray-500">No activity yet</p>
                <p className="text-xs text-gray-400 mt-1">Browse listings and click or like properties to track your interest here.</p>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {activityList.map(item => {
                  const agentColor = AGENT_COLORS[item.property.agent_email] || { bg: '#F8FAFC', text: '#64748B', border: '#E2E8F0' }
                  const isNew = item.propertyTitle === latestActivityTitle
                  const isHighInterest = item.view_count >= 3 || item.lead_score >= 70
                  return (
                    <div key={item.propertyTitle}
                      className={`flex items-center gap-4 p-4 rounded-2xl cursor-pointer transition-shadow hover:shadow-md ${isNew ? 'new-item-slide-in' : ''}`}
                      style={{
                        background: isHighInterest ? 'linear-gradient(135deg, #FFFBEB, #FEF9EC)' : 'white',
                        border: `1px solid ${isHighInterest ? '#FCD34D' : '#F1F3F5'}`,
                        boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
                      }}
                      onClick={() => setSelectedListing(item.property)}
                    >
                      <div className="w-16 h-16 rounded-xl overflow-hidden shrink-0">
                        <img src={item.property.image_url} alt={item.propertyTitle} className="w-full h-full object-cover" />
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                          {isHighInterest && (
                            <span className="text-xs font-bold px-1.5 py-0.5 rounded"
                              style={{ background: '#FEF3C7', color: '#B45309' }}>HIGH INTEREST</span>
                          )}
                          <p className="text-sm font-semibold text-gray-800 truncate">{item.propertyTitle}</p>
                        </div>
                        <p className="text-xs text-gray-400 flex items-center gap-1 mb-2">
                          <MapPin size={10} /> {item.property.location}
                        </p>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="flex items-center gap-1 px-2 py-0.5 rounded-lg text-xs font-medium"
                            style={{ background: agentColor.bg, color: agentColor.text, border: `1px solid ${agentColor.border}` }}>
                            <UserCircle size={10} /> {item.property.agent_name}
                          </span>
                          <span className="flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-lg"
                            style={{ background: '#F0F9FF', color: '#0369A1', border: '1px solid #BAE6FD' }}>
                            <Eye size={10} /> {item.view_count} view{item.view_count !== 1 ? 's' : ''}
                          </span>
                          {item.liked && (
                            <span className="flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-lg"
                              style={{ background: '#FFF1F2', color: '#BE123C', border: '1px solid #FECDD3' }}>
                              <Heart size={10} fill="#BE123C" color="#BE123C" /> Liked
                            </span>
                          )}
                          <span className="flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-lg"
                            style={{ background: '#F5F3FF', color: '#6D28D9', border: '1px solid #DDD6FE' }}>
                            <TrendingUp size={10} /> Score {item.lead_score}
                          </span>
                        </div>
                      </div>

                      <div className="text-right shrink-0">
                        <p className="text-sm font-bold text-gray-800">{formatPrice(item.property.price)}</p>
                        {item.last_activity && (
                          <p className="text-xs text-gray-400 mt-0.5">{timeAgo(item.last_activity)}</p>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* ── Property Detail Modal ── */}
        {selectedListing && (() => {
          const { bed, bath, sqft } = parseSpecs(selectedListing.specs)
          const liked = favorites.has(selectedListing.id)
          const myViews = propertyLeads[selectedListing.title]?.view_count ?? 0
          const agentColor = AGENT_COLORS[selectedListing.agent_email] || { bg: '#F8FAFC', text: '#64748B', border: '#E2E8F0' }
          return (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
              style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)' }}
              onClick={() => setSelectedListing(null)}>
              <div className="w-full max-w-lg rounded-2xl overflow-hidden"
                style={{ background: 'white', boxShadow: '0 24px 48px rgba(0,0,0,0.2)' }}
                onClick={e => e.stopPropagation()}>
                <div className="relative h-56">
                  <img src={selectedListing.image_url} alt={selectedListing.title} className="w-full h-full object-cover" />
                  <button onClick={() => setSelectedListing(null)}
                    className="absolute top-3 right-3 w-9 h-9 rounded-xl flex items-center justify-center bg-white/90 border-none cursor-pointer">
                    <X size={18} color="#475569" />
                  </button>
                  <div className="absolute bottom-4 left-4">
                    <p className="text-2xl font-bold text-white" style={{ textShadow: '0 2px 8px rgba(0,0,0,0.3)' }}>
                      {formatPrice(selectedListing.price)}
                    </p>
                  </div>
                </div>

                <div className="p-6">
                  <div className="flex items-start justify-between gap-3 mb-3">
                    <div>
                      <h3 className="text-lg font-bold text-gray-800">{selectedListing.title}</h3>
                      <p className="text-sm text-gray-400 flex items-center gap-1 mt-0.5"><MapPin size={13} /> {selectedListing.location}</p>
                    </div>
                    {selectedListing.agent_name && (
                      <div className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-xl"
                        style={{ background: agentColor.bg, border: `1px solid ${agentColor.border}` }}>
                        <UserCircle size={14} color={agentColor.text} />
                        <div>
                          <p className="text-xs font-semibold" style={{ color: agentColor.text }}>{selectedListing.agent_name}</p>
                          <p className="text-xs" style={{ color: agentColor.text, opacity: 0.7 }}>Your Agent</p>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-5 py-3" style={{ borderTop: '1px solid #F1F3F5', borderBottom: '1px solid #F1F3F5' }}>
                    <span className="text-sm text-gray-600 flex items-center gap-1.5"><Bed size={16} color="#3B82F6" /> {bed} Beds</span>
                    <span className="text-sm text-gray-600 flex items-center gap-1.5"><Bath size={16} color="#3B82F6" /> {bath} Baths</span>
                    <span className="text-sm text-gray-600 flex items-center gap-1.5"><Maximize size={16} color="#3B82F6" /> {sqft} sqft</span>
                    <span className="text-sm text-gray-600 flex items-center gap-1.5">
                      <Eye size={16} color="#3B82F6" /> {myViews} view{myViews !== 1 ? 's' : ''}
                    </span>
                  </div>

                  <p className="text-sm text-gray-500 mt-4 leading-relaxed">{selectedListing.description}</p>

                  <div className="flex gap-3 mt-5">
                    <button className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-semibold text-white border-none cursor-pointer hover:scale-[1.01] transition-all"
                      style={{ background: 'linear-gradient(135deg, #3B82F6, #2563EB)', boxShadow: '0 2px 8px rgba(59,130,246,0.35)' }}>
                      <Send size={15} /> Request Showing
                    </button>
                    <button onClick={e => toggleFavorite(selectedListing.id, selectedListing, e)}
                      className="w-12 h-12 rounded-xl flex items-center justify-center cursor-pointer transition-all hover:scale-105"
                      style={{ border: '1px solid #E2E8F0', background: liked ? '#FEF2F2' : 'white' }}>
                      <Heart size={20} color={liked ? '#EF4444' : '#94A3B8'} fill={liked ? '#EF4444' : 'none'} />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )
        })()}
      </main>
    </div>
  )
}
