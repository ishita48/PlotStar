'use client';

import { useEffect, useRef, useState } from 'react';
import { Leaf, MapPin, Plus, ShieldCheck, Sparkles } from 'lucide-react';
import { type Module, PrimaryCard, Sidebar, StepNavigation } from './shell';
import { DesignModule, ProtectModule } from './protection-workspace';
import { useProtection } from './use-protection';
import { DescribePreview, FinalizePreview, PickPreview } from './locate-preview';
import { sampleProjectTypes, sampleSites, type PreviewProjectType } from './sample-data';

// Locate remains an independent UI preview. Design/Protect share a persisted simulation workspace.
export function DashboardTwo() {
  const [module, setModule] = useState<Module>('locate');
  const [step, setStep] = useState(0);
  const [type, setType] = useState<PreviewProjectType>('data-center');
  const [brief, setBrief] = useState<string>(sampleProjectTypes[0].brief);
  const [city, setCity] = useState('Houston, Texas');
  const [selectedId, setSelectedId] = useState<string>(sampleSites[0].id);
  const [completed, setCompleted] = useState([false, false, false]);
  const heading = useRef<HTMLHeadingElement>(null);
  const firstRender = useRef(true);
  const selected = sampleSites.find((site) => site.id === selectedId) || sampleSites[0];
  const projectType = sampleProjectTypes.find((project) => project.id === type)!;
  const facility = {
    id: `d2-${selected.id}-${type}-${city
      .split(',')[0]
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, '-')}`,
    name: selected.name,
    city,
    type: projectType.label,
  };
  const protection = useProtection(facility, module !== 'locate' && completed[2]);

  useEffect(() => {
    if (!firstRender.current) {
      heading.current?.focus({ preventScroll: true });
      window.scrollTo({ top: 0, behavior: 'instant' });
    }
    firstRender.current = false;
  }, [module, step]);

  function advance(index: number) {
    setCompleted((current) => current.map((done, i) => i === index || done));
    if (index < 2) setStep(index + 1);
  }

  function reset() {
    setModule('locate');
    setStep(0);
    setType('data-center');
    setBrief(sampleProjectTypes[0].brief);
    setCity('Houston, Texas');
    setSelectedId(sampleSites[0].id);
    setCompleted([false, false, false]);
  }

  return (
    <div className="d2-shell">
      <Sidebar
        active={module}
        complete={completed[2]}
        onSelect={setModule}
        statuses={{
          locate: completed[2] ? 'completed' : 'active',
          design:
            completed[2] && protection.state.modelAccepted
              ? 'completed'
              : module === 'design'
                ? 'active'
                : 'pending',
          protect:
            completed[2] && protection.state.deployed
              ? 'completed'
              : (completed[2] && protection.state.configured) || module === 'protect'
                ? 'active'
                : 'pending',
        }}
      >
        <div className="d2-sidebar-note">
          <span className="d2-note-icon">
            <Leaf size={18} />
          </span>
          <h2>
            Big ideas.
            <br />
            Thoughtful beginnings.
          </h2>
          <p>
            Define what you want to build.
            <br />
            Find the best place to build it.
          </p>
        </div>
        <div className="d2-preview-project">
          <span className="d2-overline">YOUR CONCEPT</span>
          <b>
            <projectType.icon size={16} />
            {projectType.label}
          </b>
          <span>{city}</span>
        </div>
        <button className="d2-new-project" onClick={reset}>
          <Plus size={15} /> Reset preview
        </button>
      </Sidebar>
      <main className="d2-workspace" id="d2-main">
        <header className="d2-topline">
          <span>
            Workspace <span>/</span>
            <b>{module === 'locate' ? 'Locate' : module === 'design' ? 'Design' : 'Protect'}</b>
          </span>
          <span className="d2-edition">
            DASHBOARD 02 <span>{module === 'locate' ? 'UI PREVIEW' : 'HAVEN · SIMULATION'}</span>
          </span>
        </header>
        {module === 'locate' ? (
          <StepNavigation step={step} completed={completed} onSelect={setStep} busy={false} />
        ) : module === 'design' ? (
          <div className="d2-module-bar">
            <span>DESIGN STUDIO</span>
            <span>{selected.name} · sample twin</span>
          </div>
        ) : null}
        {module !== 'locate' && protection.error && (
          <div className="hv-save-error" role="alert">
            <span>{protection.error} Changes have not been saved.</span>
            <button onClick={() => void protection.reload()}>Reload workspace</button>
          </div>
        )}
        {module !== 'locate' ? (
          !completed[2] ? (
            <PrimaryCard className="hv-prerequisite">
              <MapPin size={42} />
              <h1>First, find its place.</h1>
              <p>Finish Locate to carry your selected facility into Design and Protect.</p>
              <button className="d2-button" onClick={() => setModule('locate')}>
                Return to Locate
              </button>
            </PrimaryCard>
          ) : protection.loading ? (
            <PrimaryCard>
              <div className="hv-model-loading" role="status">
                Loading the facility’s protection workspace…
              </div>
            </PrimaryCard>
          ) : module === 'design' ? (
            <DesignModule
              state={protection.state}
              busy={protection.busy}
              act={protection.act}
              onProtect={() => setModule('protect')}
            />
          ) : (
            <ProtectModule
              key={facility.id}
              state={protection.state}
              busy={protection.busy}
              act={protection.act}
              onDesign={() => setModule('design')}
            />
          )
        ) : (
          <>
            {step === 0 && (
              <DescribePreview
                type={type}
                setType={setType}
                brief={brief}
                setBrief={setBrief}
                city={city}
                setCity={setCity}
                onContinue={() => advance(0)}
                headingRef={heading}
              />
            )}
            {step === 1 && (
              <PickPreview
                selected={selected}
                onSelect={setSelectedId}
                city={city}
                onContinue={() => advance(1)}
                headingRef={heading}
              />
            )}
            {step === 2 && (
              <FinalizePreview
                site={selected}
                city={city}
                projectLabel={projectType.label}
                complete={completed[2]}
                onBack={() => setStep(1)}
                onConfirm={() => advance(2)}
                onDesign={() => setModule('design')}
                headingRef={heading}
              />
            )}
            {step !== 1 && (
              <div className="d2-support">
                <div>
                  <span className="d2-support-icon">
                    <MapPin size={18} />
                  </span>
                  <b>A place with purpose.</b>
                  <p>Great possibilities start with a thoughtful location.</p>
                </div>
                <div>
                  <span className="d2-support-icon">
                    <Sparkles size={18} />
                  </span>
                  <b>See the bigger picture.</b>
                  <p>Money, people, and planet. Room for all three.</p>
                </div>
                <div>
                  <span className="d2-support-icon">
                    <ShieldCheck size={18} />
                  </span>
                  <b>One connected journey.</b>
                  <p>From the first idea to what comes next.</p>
                </div>
              </div>
            )}
          </>
        )}
        <footer className="d2-footer">
          <span>
            AFTERLIGHT <i /> Built around your next possibility.
          </span>
          <span>
            {module === 'locate'
              ? 'INTERFACE PREVIEW · SAMPLE DATA'
              : 'HAVEN · SIMULATION ONLY · SQLITE WORKSPACE'}
          </span>
        </footer>
      </main>
    </div>
  );
}
