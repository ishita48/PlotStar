import Link from 'next/link';
import {
  ArrowUpRight,
  ArrowRight,
  MapPin,
  Box,
  ShieldCheck,
  Building2,
  Cpu,
  Trees,
  Store,
  ScanLine,
  Sparkles,
  Check,
  ChevronRight,
} from 'lucide-react';
import { Brand, Star } from '@/components/brand';
import { CityArt } from '@/components/city-art';
import { Button } from '@/components/ui/button';
export default function Home() {
  return (
    <main className="landing">
      <nav className="landing-nav">
        <Brand />
        <div className="nav-links">
          <a href="#platform">The platform</a>
          <a href="#possibilities">Built for you</a>
          <a href="#intelligence">Our approach</a>
        </div>
        <Button asChild variant="secondary">
          <Link href="/explore">
            Open workspace <ArrowUpRight size={16} />
          </Link>
        </Button>
      </nav>
      <section className="hero">
        <div className="hero-copy">
          <div className="eyebrow">
            <span className="pulse-dot" /> THE NEXT CHAPTER OF DEVELOPMENT
          </div>
          <h1>
            Find it.
            <br />
            Design it.
            <br />
            <span>Protect it.</span>
            <Star className="hero-star" />
          </h1>
          <p>
            Great developments start with a better perspective. Bring site intelligence, conceptual
            design, and building protection into one connected workspace.
          </p>
          <div className="hero-actions">
            <Button asChild>
              <Link href="/explore">
                Find a site <ArrowUpRight size={18} />
              </Link>
            </Button>
            <Link href="/projects/demo-2" className="text-link">
              Explore the demo <ArrowRight size={17} />
            </Link>
          </div>
          <div className="hero-note">
            <span className="mini-stack">
              <MapPin size={13} />
              <Box size={13} />
              <ShieldCheck size={13} />
            </span>{' '}
            From first possibility to lasting impact.
          </div>
        </div>
        <div className="hero-visual">
          <div className="visual-grid" />
          <div className="visual-topline">
            <span>
              <span className="pulse-dot" /> PLOTSTAR INTELLIGENCE
            </span>
            <span>PRINCETON, NJ ↗</span>
          </div>
          <CityArt />
          <div className="visual-bottom">
            <span>YOUR VISION. A CLEARER PATH.</span>
            <span>40.3573° N · 74.6672° W</span>
          </div>
          <div className="hero-visual-tag">
            <ShieldCheck size={18} />
            <span>
              Every decision.
              <br />
              <b>Connected.</b>
            </span>
            <span className="tag-line" />
          </div>
        </div>
      </section>
      <div className="trust-strip">
        <span>A NEW PERSPECTIVE ON THE BUILT WORLD</span>
        <span>
          <Building2 size={18} /> Development intelligence
        </span>
        <span>
          <ScanLine size={18} /> Generative planning
        </span>
        <span>
          <ShieldCheck size={18} /> HAVEN protection
        </span>
      </div>
      <section id="platform" className="platform-section">
        <div className="section-heading">
          <div>
            <div className="eyebrow">ONE PLATFORM. FROM THE GROUND UP.</div>
            <h2>
              See the whole picture.
              <br />
              <span>Build with conviction.</span>
            </h2>
          </div>
          <p>
            Move from “what if” to “what’s next.”
            <br />
            Three powerful stages. One continuous project.
          </p>
        </div>
        <div className="stage-cards">
          {[
            {
              n: '01',
              title: 'Discover',
              sub: 'The right place changes everything.',
              text: 'Compare locations with intelligence built for your development. Understand the tradeoffs before you break ground.',
              icon: MapPin,
              href: '/projects/demo-1',
              class: 'discover-mini',
            },
            {
              n: '02',
              title: 'Design',
              sub: 'Give your ambition a little dimension.',
              text: 'Explore conceptual alternatives, shape a 3D vision, and see how every change affects your project.',
              icon: Box,
              href: '/projects/demo-2',
              class: 'design-mini',
            },
            {
              n: '03',
              title: 'Protect',
              sub: 'A smarter building starts here.',
              text: 'Plan connected sensors, test incident response, and bring your conceptual digital twin to life with HAVEN.',
              icon: ShieldCheck,
              href: '/projects/demo-3',
              class: 'protect-mini',
            },
          ].map((s, i) => (
            <Link href={s.href} className="stage-card" key={s.n}>
              <div className="stage-card-top">
                <span>
                  {s.n} / {s.title.toUpperCase()}
                </span>
                <s.icon size={20} />
              </div>
              <div className={`stage-mini ${s.class}`}>
                {i === 0 ? (
                  <>
                    <span className="map-road r1" />
                    <span className="map-road r2" />
                    <span className="map-road r3" />
                    <span className="parcel p1" />
                    <span className="parcel p2" />
                    <div className="mini-map-label">
                      <MapPin size={14} /> The next great place.
                    </div>
                  </>
                ) : i === 1 ? (
                  <div className="iso-mini">
                    <i />
                    <i />
                    <i />
                  </div>
                ) : (
                  <div className="sensor-mini">
                    <div className="sensor-orbit" />
                    <ShieldCheck size={48} />
                    <span className="mini-sensor a" />
                    <span className="mini-sensor b" />
                    <span className="mini-sensor c" />
                  </div>
                )}
              </div>
              <h3>
                {s.title} <ArrowUpRight size={20} />
              </h3>
              <h4>{s.sub}</h4>
              <p>{s.text}</p>
            </Link>
          ))}
        </div>
      </section>
      <section id="possibilities" className="possibilities">
        <div>
          <div className="eyebrow">DIFFERENT AMBITIONS. PURPOSE-BUILT INTELLIGENCE.</div>
          <h2>What will you build?</h2>
        </div>
        <div className="use-cases">
          {[
            {
              icon: Building2,
              name: 'Places to live',
              detail: 'Student housing & residential',
              demo: 1,
            },
            {
              icon: Cpu,
              name: 'Power for tomorrow',
              detail: 'Data centers & infrastructure',
              demo: 2,
            },
            { icon: Store, name: 'Room for business', detail: 'Commercial & mixed use', demo: 0 },
            { icon: Trees, name: 'Space to connect', detail: 'Parks & community spaces', demo: 3 },
          ].map((s) => (
            <Link
              href={s.demo ? `/projects/demo-${s.demo}` : '/projects?new=1&type=commercial'}
              key={s.name}
            >
              <s.icon size={25} />
              <h3>{s.name}</h3>
              <p>{s.detail}</p>
              <ArrowUpRight size={17} />
            </Link>
          ))}
        </div>
      </section>
      <section id="intelligence" className="intelligence-section">
        <div className="intelligence-orbit">
          <Star />
          <span className="orbit-word a">LOCATION</span>
          <span className="orbit-word b">DESIGN</span>
          <span className="orbit-word c">PROTECTION</span>
        </div>
        <div>
          <div className="eyebrow">INTELLIGENCE WITH ITS FEET ON THE GROUND</div>
          <h2>
            Your next move,
            <br />
            better informed.
          </h2>
          <p>
            Ask better questions. Explore the alternatives. Understand what’s known, what’s assumed,
            and what needs a closer look.
          </p>
          <ul>
            <li>
              <Check size={17} /> Development-specific scoring and transparent assumptions
            </li>
            <li>
              <Check size={17} /> Interactive 3D concepts and connected financial scenarios
            </li>
            <li>
              <Check size={17} /> Real sensor integration when your hardware is ready
            </li>
          </ul>
          <Link href="/projects" className="text-link">
            Meet your new workspace <ChevronRight size={17} />
          </Link>
        </div>
      </section>
      <section className="landing-cta">
        <Star />
        <div>
          <div className="eyebrow">THE FUTURE DOESN’T BUILD ITSELF.</div>
          <h2>Let’s find your next possibility.</h2>
        </div>
        <Button asChild variant="secondary">
          <Link href="/projects?new=1">
            Start building <ArrowUpRight size={18} />
          </Link>
        </Button>
      </section>
      <footer className="landing-footer">
        <Brand />
        <span>Find it. Design it. Protect it.</span>
        <p>© {new Date().getFullYear()} PlotStar · Conceptual intelligence. Human ambition.</p>
        <Link href="/projects">
          Enter workspace <ArrowUpRight size={14} />
        </Link>
      </footer>
    </main>
  );
}
