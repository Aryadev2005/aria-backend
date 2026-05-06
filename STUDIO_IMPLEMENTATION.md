import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Pin, PinOff, Clock, Sparkles, ChevronDown, ChevronUp, Save, Brain } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  useScriptStructure,
  useScriptHistory,
  useSaveSession,
  useLearnFromEdit,
  useTogglePin,
} from '@/hooks/useApi';
import { useFirebaseAuth } from '@/lib/FirebaseAuthContext';

const INTENT_OPTIONS = [
  { value: 'tightened_language', label: '✂️ Tightened the language' },
  { value: 'changed_tone',       label: '🎭 Changed the tone' },
  { value: 'voice_was_off',      label: '🎙️ My voice was off' },
  { value: 'facts_were_wrong',   label: '❌ Facts were wrong' },
  { value: 'restructured',       label: '🔀 Restructured it' },
  { value: 'other',              label: '💬 Other' },
];

const container = { hidden: {}, show: { transition: { staggerChildren: 0.06 } } };
const item = {
  hidden: { opacity: 0, y: 20 },
  show: { opacity: 1, y: 0, transition: { type: 'spring', damping: 25 } },
};

// ── Section Editor ────────────────────────────────────────────────────────────
function SectionCard({ section, onChange }) {
  const [open, setOpen] = useState(true);

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-5 py-3 hover:bg-muted/40 transition-colors"
      >
        <div className="flex items-center gap-3">
          <span className="font-body font-semibold text-sm text-primary">{section.label}</span>
          <span className="text-muted-foreground font-body text-xs">{section.duration}</span>
        </div>
        {open ? <ChevronUp size={16} className="text-muted-foreground" /> : <ChevronDown size={16} className="text-muted-foreground" />}
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="px-5 pb-5 space-y-3">
              <Textarea
                value={section.content}
                onChange={(e) => onChange(section.id, e.target.value)}
                className="bg-background border-border rounded-xl font-body text-sm min-h-[80px] resize-none focus:ring-primary"
              />
              {section.ariaTip && (
                <div className="flex items-start gap-2 bg-accent/50 rounded-lg px-3 py-2">
                  <Brain size={13} className="text-primary mt-0.5 shrink-0" />
                  <p className="font-body text-xs text-muted-foreground leading-relaxed">{section.ariaTip}</p>
                </div>
              )}
              {section.bRollIdea && (
                <p className="font-body text-xs text-muted-foreground/60">🎥 {section.bRollIdea}</p>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Intent Modal ──────────────────────────────────────────────────────────────
function IntentModal({ onSelect, onSkip }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 bg-black/60 z-50 flex items-end sm:items-center justify-center p-4"
    >
      <motion.div
        initial={{ y: 60, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 60, opacity: 0 }}
        className="bg-card border border-border rounded-2xl w-full max-w-sm p-6 space-y-4"
      >
        <div>
          <h3 className="font-heading text-lg text-foreground">What did you change?</h3>
          <p className="font-body text-sm text-muted-foreground mt-1">ARIA learns from this to write better scripts for you next time.</p>
        </div>
        <div className="space-y-2">
          {INTENT_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => onSelect(opt.value)}
              className="w-full text-left px-4 py-3 rounded-xl bg-muted hover:bg-muted/80 font-body text-sm text-foreground transition-colors"
            >
              {opt.label}
            </button>
          ))}
        </div>
        <button
          onClick={onSkip}
          className="w-full text-center font-body text-xs text-muted-foreground hover:text-foreground transition-colors py-1"
        >
          Skip — just save
        </button>
      </motion.div>
    </motion.div>
  );
}

// ── History Panel ─────────────────────────────────────────────────────────────
function HistoryPanel({ onSelect, onClose }) {
  const { data, isLoading } = useScriptHistory();
  const { mutate: togglePin } = useTogglePin();
  const scripts = data?.data || [];

  const pinned = scripts.filter((s) => s.pinned);
  const recent = scripts.filter((s) => !s.pinned);

  const renderScript = (s) => (
    <div
      key={s.id}
      className="flex items-start justify-between gap-3 p-3 rounded-xl hover:bg-muted/60 transition-colors group cursor-pointer"
      onClick={() => onSelect(s)}
    >
      <div className="flex-1 min-w-0">
        <p className="font-body text-sm text-foreground truncate">{s.idea}</p>
        <p className="font-body text-xs text-muted-foreground mt-0.5">
          {s.platform} · {new Date(s.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
        </p>
      </div>
      <button
        onClick={(e) => { e.stopPropagation(); togglePin(s.id); }}
        className="opacity-0 group-hover:opacity-100 transition-opacity p-1.5 rounded-lg hover:bg-muted"
      >
        {s.pinned ? <PinOff size={14} className="text-primary" /> : <Pin size={14} className="text-muted-foreground" />}
      </button>
    </div>
  );

  return (
    <motion.div
      initial={{ x: '100%' }}
      animate={{ x: 0 }}
      exit={{ x: '100%' }}
      transition={{ type: 'spring', damping: 30, stiffness: 300 }}
      className="fixed inset-y-0 right-0 w-80 bg-card border-l border-border z-40 flex flex-col shadow-2xl"
    >
      <div className="flex items-center justify-between px-5 py-4 border-b border-border">
        <h3 className="font-heading text-base text-foreground">Script History</h3>
        <button onClick={onClose} className="font-body text-sm text-muted-foreground hover:text-foreground">Close</button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-4">
        {isLoading && (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-14 bg-muted rounded-xl animate-pulse" />
            ))}
          </div>
        )}

        {!isLoading && pinned.length > 0 && (
          <div>
            <p className="font-body text-xs font-semibold text-muted-foreground uppercase tracking-wider px-3 mb-1">📌 Pinned</p>
            {pinned.map(renderScript)}
          </div>
        )}

        {!isLoading && recent.length > 0 && (
          <div>
            <p className="font-body text-xs font-semibold text-muted-foreground uppercase tracking-wider px-3 mb-1">Recent</p>
            {recent.map(renderScript)}
          </div>
        )}

        {!isLoading && scripts.length === 0 && (
          <p className="font-body text-sm text-muted-foreground text-center py-8">No scripts yet. Generate your first one!</p>
        )}
      </div>
    </motion.div>
  );
}

// ── Main Studio ───────────────────────────────────────────────────────────────
export default function Studio() {
  const { dbUser } = useFirebaseAuth();

  const [idea, setIdea]                   = useState('');
  const [result, setResult]               = useState(null);
  const [editedSections, setEditedSections] = useState([]);
  const [generatedSections, setGeneratedSections] = useState([]);
  const [sessionId, setSessionId]         = useState(null);
  const [showHistory, setShowHistory]     = useState(false);
  const [showIntent, setShowIntent]       = useState(false);
  const [saving, setSaving]               = useState(false);
  const [saved, setSaved]                 = useState(false);
  const [error, setError]                 = useState(null);

  const { mutateAsync: generateScript, isPending } = useScriptStructure();
  const { mutateAsync: saveSession }               = useSaveSession();
  const { mutateAsync: learnFromEdit }             = useLearnFromEdit();

  const handleGenerate = async () => {
    if (!idea.trim()) return;
    setError(null);
    setResult(null);
    setSaved(false);
    setSessionId(null);

    try {
      const res = await generateScript({
        idea,
        platform: dbUser?.primary_platform || 'instagram',
        niche: dbUser?.niches?.[0] || 'general',
        archetype: dbUser?.archetype || 'CREATOR',
        followerRange: dbUser?.follower_range || '1K-10K',
      });

      const data = res.data;
      setResult(data);
      setGeneratedSections(data.sections || []);
      setEditedSections(JSON.parse(JSON.stringify(data.sections || [])));

      // Auto-save initial generation
      const saved = await saveSession({
        idea,
        platform: dbUser?.primary_platform || 'instagram',
        niche: dbUser?.niches?.[0] || 'general',
        generatedScript: data,
        editedScript: {},
      });
      setSessionId(saved?.data?.sessionId || null);
    } catch (e) {
      console.error('Generation failed', e);
      setError('Could not generate script. Please try again.');
    }
  };

  const handleSectionChange = (sectionId, newContent) => {
    setEditedSections((prev) =>
      prev.map((s) => (s.id === sectionId ? { ...s, content: newContent } : s))
    );
    setSaved(false);
  };

  const handleSaveClick = () => {
    // Check if user actually edited anything
    const hasEdits = editedSections.some((s, i) => {
      const gen = generatedSections[i];
      return gen && s.content !== gen.content;
    });

    if (hasEdits) {
      setShowIntent(true);
    } else {
      handleSaveFinal(null);
    }
  };

  const handleSaveFinal = async (intentLabel) => {
    setShowIntent(false);
    setSaving(true);

    try {
      if (intentLabel) {
        await learnFromEdit({
          generatedSections,
          editedSections,
          intentLabel,
          sessionId,
        });
      }

      await saveSession({
        idea,
        platform: dbUser?.primary_platform || 'instagram',
        niche: dbUser?.niches?.[0] || 'general',
        generatedScript: result,
        editedScript: { sections: editedSections },
      });

      setSaved(true);
    } catch (e) {
      console.error('Save failed', e);
    } finally {
      setSaving(false);
    }
  };

  const handleHistorySelect = (script) => {
    const activeScript = script.edited_script?.sections?.length
      ? script.edited_script
      : script.generated_script;

    setIdea(script.idea);
    setResult(activeScript);
    setGeneratedSections(script.generated_script?.sections || []);
    setEditedSections(
      JSON.parse(JSON.stringify(activeScript?.sections || []))
    );
    setSessionId(script.id);
    setShowHistory(false);
    setSaved(false);
  };

  return (
    <>
      <AnimatePresence>
        {showHistory && (
          <HistoryPanel
            onSelect={handleHistorySelect}
            onClose={() => setShowHistory(false)}
          />
        )}
        {showIntent && (
          <IntentModal
            onSelect={(label) => handleSaveFinal(label)}
            onSkip={() => handleSaveFinal(null)}
          />
        )}
      </AnimatePresence>

      <motion.div variants={container} initial="hidden" animate="show" className="space-y-6 pb-20">

        {/* Header */}
        <motion.div variants={item} className="flex items-center justify-between">
          <div>
            <h1 className="font-heading text-2xl text-foreground mb-1">Studio</h1>
            <p className="text-muted-foreground font-body text-sm">Write your idea. ARIA builds the script.</p>
          </div>
          <button
            onClick={() => setShowHistory(true)}
            className="flex items-center gap-2 px-3 py-2 rounded-xl bg-muted hover:bg-muted/80 transition-colors"
          >
            <Clock size={15} className="text-muted-foreground" />
            <span className="font-body text-sm text-muted-foreground">History</span>
          </button>
        </motion.div>

        {/* Idea Input */}
        <motion.div variants={item} className="space-y-3">
          <Textarea
            placeholder="What's your content idea? Be as specific or vague as you like — ARIA fills in the rest."
            value={idea}
            onChange={(e) => setIdea(e.target.value)}
            className="bg-card border-border rounded-xl font-body text-sm min-h-[100px] resize-none focus:ring-primary"
          />
          {error && <p className="text-destructive font-body text-sm">{error}</p>}
          <Button
            onClick={handleGenerate}
            disabled={isPending || !idea.trim()}
            className="bg-primary hover:bg-primary/90 text-white rounded-pill px-8 font-body font-semibold shadow-warm w-full sm:w-auto"
          >
            {isPending ? (
              <span className="flex items-center gap-2">
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                ARIA is writing...
              </span>
            ) : (
              <span className="flex items-center gap-2">
                <Sparkles size={16} /> Generate Script
              </span>
            )}
          </Button>
        </motion.div>

        {/* Loading skeleton */}
        {isPending && (
          <div className="space-y-3">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-24 bg-muted rounded-xl animate-pulse" />
            ))}
          </div>
        )}

        {/* Script Output */}
        <AnimatePresence>
          {result && !isPending && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-4"
            >
              {/* Hook highlight */}
              {result.hookLine && (
                <div className="bg-primary/10 border border-primary/20 rounded-xl px-5 py-4">
                  <p className="font-body text-xs font-semibold text-primary uppercase tracking-wider mb-1">Hook Line</p>
                  <p className="font-heading text-lg text-foreground">"{result.hookLine}"</p>
                  {result.hookTip && (
                    <p className="font-body text-xs text-muted-foreground mt-2">{result.hookTip}</p>
                  )}
                </div>
              )}

              {/* Editable sections */}
              <div className="space-y-3">
                {editedSections.map((section) => (
                  <SectionCard
                    key={section.id}
                    section={section}
                    onChange={handleSectionChange}
                  />
                ))}
              </div>

              {/* Shooting tips */}
              {result.shootingTips?.length > 0 && (
                <div className="bg-card border border-border rounded-xl p-5">
                  <p className="font-body font-semibold text-sm text-foreground mb-3">📱 Shooting Tips</p>
                  <div className="space-y-2">
                    {result.shootingTips.map((tip, i) => (
                      <p key={i} className="font-body text-sm text-muted-foreground">• {tip}</p>
                    ))}
                  </div>
                </div>
              )}

              {/* Stats row */}
              {(result.estimatedViews || result.viralPotential) && (
                <div className="flex gap-3">
                  {result.estimatedViews && (
                    <div className="flex-1 bg-card border border-border rounded-xl p-4 text-center">
                      <p className="font-body text-xs text-muted-foreground mb-1">Estimated Views</p>
                      <p className="font-heading text-lg text-foreground">{result.estimatedViews}</p>
                    </div>
                  )}
                  {result.viralPotential && (
                    <div className="flex-1 bg-card border border-border rounded-xl p-4 text-center">
                      <p className="font-body text-xs text-muted-foreground mb-1">Viral Score</p>
                      <p className="font-heading text-lg text-primary">{result.viralPotential}%</p>
                    </div>
                  )}
                </div>
              )}

              {/* Common mistake */}
              {result.commonMistake && (
                <div className="bg-destructive/10 border border-destructive/20 rounded-xl px-5 py-4">
                  <p className="font-body text-xs font-semibold text-destructive uppercase tracking-wider mb-1">Common Mistake</p>
                  <p className="font-body text-sm text-foreground">{result.commonMistake}</p>
                </div>
              )}

              {/* Save button */}
              <div className="flex items-center gap-3">
                <Button
                  onClick={handleSaveClick}
                  disabled={saving || saved}
                  className={`rounded-pill px-8 font-body font-semibold ${
                    saved
                      ? 'bg-rising/20 text-rising border border-rising/30'
                      : 'bg-card border border-border text-foreground hover:bg-muted'
                  }`}
                >
                  {saving ? (
                    <span className="flex items-center gap-2">
                      <div className="w-4 h-4 border-2 border-foreground/30 border-t-foreground rounded-full animate-spin" />
                      Saving...
                    </span>
                  ) : saved ? (
                    <span className="flex items-center gap-2">✓ Saved</span>
                  ) : (
                    <span className="flex items-center gap-2">
                      <Save size={15} /> Save Script
                    </span>
                  )}
                </Button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </>
  );
}
