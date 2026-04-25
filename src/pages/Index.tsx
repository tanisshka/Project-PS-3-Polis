import { FormEvent, useEffect, useMemo, useState } from "react";
import "leaflet/dist/leaflet.css";
import L, { DivIcon } from "leaflet";
import { MapContainer, Marker, Popup, TileLayer, useMap, useMapEvents } from "react-leaflet";
import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  Construction,
  Leaf,
  ListChecks,
  Loader2,
  LocateFixed,
  LogOut,
  MapPin,
  Plus,
  Recycle,
  ShieldAlert,
  Sparkles,
  ThumbsUp,
  UserCog,
} from "lucide-react";
import type { Session } from "@supabase/supabase-js";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import civicHills from "@/assets/civic-hills-auth.jpg";

const STORAGE_KEY = "civic-issues-v1";
const ROLE_KEY = "civic-role-v1";
const VOTES_KEY = "civic-voted-issues-v1";
const CENTER: [number, number] = [40.7128, -74.006];
const REGION_RADIUS_KM = 8;

type Category = "infrastructure" | "sanitation" | "safety" | "greenery";
type Status = "new" | "in_progress" | "resolved";
type Role = "user" | "admin";

type Issue = {
  id: string;
  title: string;
  description: string;
  latitude: number;
  longitude: number;
  category: Category;
  status: Status;
  votes: number;
  timestamp: number;
};

type Cluster = {
  id: string;
  latitude: number;
  longitude: number;
  issues: Issue[];
};

const categoryMeta: Record<Category, { label: string; icon: typeof Construction; marker: string }> = {
  infrastructure: { label: "Infrastructure", icon: Construction, marker: "marker-infrastructure" },
  sanitation: { label: "Sanitation", icon: Recycle, marker: "marker-sanitation" },
  safety: { label: "Safety", icon: ShieldAlert, marker: "marker-safety" },
  greenery: { label: "Greenery", icon: Leaf, marker: "marker-greenery" },
};

const statusMeta: Record<Status, { label: string; tone: string }> = {
  new: { label: "New", tone: "bg-secondary text-secondary-foreground" },
  in_progress: { label: "In Progress", tone: "bg-warning/20 text-foreground" },
  resolved: { label: "Resolved", tone: "bg-primary/15 text-foreground" },
};

const seedIssues: Issue[] = [
  { id: "seed-1", title: "Broken curb ramp", description: "Curb ramp is cracked near the crossing.", latitude: 40.715, longitude: -74.002, category: "infrastructure", status: "new", votes: 8, timestamp: Date.now() - 86400000 },
  { id: "seed-2", title: "Overflowing bins", description: "Public bins need collection after the weekend.", latitude: 40.711, longitude: -74.011, category: "sanitation", status: "in_progress", votes: 14, timestamp: Date.now() - 54000000 },
  { id: "seed-3", title: "Dim streetlight", description: "Streetlight flickers after sunset.", latitude: 40.706, longitude: -74.004, category: "safety", status: "new", votes: 11, timestamp: Date.now() - 36000000 },
  { id: "seed-4", title: "Tree needs support", description: "Young tree leaning after high winds.", latitude: 40.718, longitude: -74.014, category: "greenery", status: "resolved", votes: 19, timestamp: Date.now() - 120000000 },
];

const localIssueTemplates: Array<Pick<Issue, "title" | "description" | "category" | "status" | "votes"> & { offset: [number, number] }> = [
  { title: "Pothole near junction", description: "Road surface has opened up and needs repair.", category: "infrastructure", status: "new", votes: 7, offset: [0.006, -0.004] },
  { title: "Garbage collection missed", description: "Waste bags are blocking the sidewalk.", category: "sanitation", status: "in_progress", votes: 12, offset: [-0.005, 0.005] },
  { title: "Unsafe crossing", description: "Pedestrian signal is not working reliably.", category: "safety", status: "new", votes: 9, offset: [0.0035, 0.007] },
  { title: "Park tree damaged", description: "A branch is hanging low after heavy wind.", category: "greenery", status: "resolved", votes: 15, offset: [-0.007, -0.006] },
];

const createRegionalSeeds = ([lat, lng]: [number, number]): Issue[] =>
  localIssueTemplates.map((template, index) => ({
    id: `local-seed-${index + 1}`,
    title: template.title,
    description: template.description,
    category: template.category,
    status: template.status,
    votes: template.votes,
    latitude: lat + template.offset[0],
    longitude: lng + template.offset[1],
    timestamp: Date.now() - (index + 1) * 36000000,
  }));

const kilometersBetween = (a: [number, number], b: [number, number]) => {
  const toRadians = (value: number) => (value * Math.PI) / 180;
  const earthRadiusKm = 6371;
  const dLat = toRadians(b[0] - a[0]);
  const dLng = toRadians(b[1] - a[1]);
  const lat1 = toRadians(a[0]);
  const lat2 = toRadians(b[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * earthRadiusKm * Math.asin(Math.sqrt(h));
};

const createIcon = (className: string, content = ""): DivIcon =>
  L.divIcon({
    className: "civic-marker",
    html: `<div class="marker-pin ${className}">${content}</div>`,
    iconSize: [36, 36],
    iconAnchor: [18, 18],
    popupAnchor: [0, -18],
  });

const distance = (a: Issue | Cluster, b: Issue | Cluster) => {
  const dx = a.latitude - b.latitude;
  const dy = a.longitude - b.longitude;
  return Math.sqrt(dx * dx + dy * dy);
};

const kMeansClusters = (issues: Issue[], zoom: number): Cluster[] => {
  if (issues.length < 7 || zoom >= 15) return issues.map((issue) => ({ id: issue.id, latitude: issue.latitude, longitude: issue.longitude, issues: [issue] }));
  const k = Math.max(2, Math.min(Math.ceil(issues.length / (zoom < 12 ? 5 : 8)), 10));
  let centers = issues.slice(0, k).map((issue) => ({ latitude: issue.latitude, longitude: issue.longitude, issues: [] as Issue[], id: issue.id }));
  for (let iteration = 0; iteration < 8; iteration += 1) {
    centers = centers.map((center) => ({ ...center, issues: [] }));
    issues.forEach((issue) => {
      const nearest = centers.reduce((best, center, index) => (distance(issue, center) < distance(issue, centers[best]) ? index : best), 0);
      centers[nearest].issues.push(issue);
    });
    centers = centers.map((center, index) => {
      if (!center.issues.length) return center;
      return {
        id: `cluster-${zoom}-${index}`,
        latitude: center.issues.reduce((sum, issue) => sum + issue.latitude, 0) / center.issues.length,
        longitude: center.issues.reduce((sum, issue) => sum + issue.longitude, 0) / center.issues.length,
        issues: center.issues,
      };
    });
  }
  return centers.filter((center) => center.issues.length);
};

function MapClickHandler({ onPick }: { onPick: (lat: number, lng: number) => void }) {
  useMapEvents({ click: (event) => onPick(event.latlng.lat, event.latlng.lng) });
  return null;
}

function ZoomWatcher({ onZoom }: { onZoom: (zoom: number) => void }) {
  const map = useMap();
  useEffect(() => {
    onZoom(map.getZoom());
    const handler = () => onZoom(map.getZoom());
    map.on("zoomend", handler);
    return () => { map.off("zoomend", handler); };
  }, [map, onZoom]);
  return null;
}

function MapResizeHandler() {
  const map = useMap();

  useEffect(() => {
    const container = map.getContainer();
    const invalidate = () => window.requestAnimationFrame(() => map.invalidateSize());
    const observer = new ResizeObserver(invalidate);

    invalidate();
    observer.observe(container);
    window.addEventListener("resize", invalidate);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", invalidate);
    };
  }, [map]);

  return null;
}

function MapCenterHandler({ center }: { center: [number, number] }) {
  const map = useMap();

  useEffect(() => {
    map.setView(center, 14, { animate: true });
  }, [center, map]);

  return null;
}

function ClusterMarker({ cluster }: { cluster: Cluster }) {
  const map = useMap();
  if (cluster.issues.length === 1) return null;
  return (
    <Marker
      position={[cluster.latitude, cluster.longitude]}
      icon={createIcon("marker-cluster", `+${cluster.issues.length}`)}
      eventHandlers={{ click: () => map.setView([cluster.latitude, cluster.longitude], Math.min(map.getZoom() + 2, 17), { animate: true }) }}
    />
  );
}

const IssueForm = ({ position, onCreate, onClose }: { position: [number, number]; onCreate: (issue: Omit<Issue, "id" | "votes" | "timestamp" | "status">) => void; onClose: () => void }) => {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<Category>("infrastructure");

  return (
    <form
      className="w-72 space-y-3 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!title.trim()) return;
        onCreate({ title, description, category, latitude: position[0], longitude: position[1] });
        onClose();
      }}
    >
      <div>
        <p className="text-sm font-bold text-foreground">Report an issue</p>
        <p className="text-xs text-muted-foreground">Pinned at {position[0].toFixed(4)}, {position[1].toFixed(4)}</p>
      </div>
      <input className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none ring-ring transition focus:ring-2" placeholder="Issue title" value={title} onChange={(event) => setTitle(event.target.value)} />
      <textarea className="min-h-20 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none ring-ring transition focus:ring-2" placeholder="Description" value={description} onChange={(event) => setDescription(event.target.value)} />
      <select className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none ring-ring transition focus:ring-2" value={category} onChange={(event) => setCategory(event.target.value as Category)}>
        {Object.entries(categoryMeta).map(([key, meta]) => <option key={key} value={key}>{meta.label}</option>)}
      </select>
      <div className="flex gap-2">
        <Button type="submit" variant="civic" size="sm" className="flex-1">Submit</Button>
        <Button type="button" variant="outline" size="sm" onClick={onClose}>Cancel</Button>
      </div>
    </form>
  );
};

const AuthScreen = ({ onAuthenticated }: { onAuthenticated: (email: string) => void }) => {
  const [isSignup, setIsSignup] = useState(false);
  const [email, setEmail] = useState("user@example.com");
  const [password, setPassword] = useState("password123");
  const [name, setName] = useState("Civic Neighbor");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("Works with Cloud auth, with instant offline fallback.");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    try {
      if (supabase) {
        const response = isSignup
          ? await supabase.auth.signUp({ email, password, options: { emailRedirectTo: window.location.origin, data: { display_name: name } } })
          : await supabase.auth.signInWithPassword({ email, password });
        if (response.error) throw response.error;
      }
      onAuthenticated(email);
    } catch (error) {
      setMessage(error instanceof Error ? `${error.message}. Continue in offline fallback.` : "Continuing in offline fallback.");
      onAuthenticated(email);
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="relative min-h-screen overflow-hidden bg-foreground">
      <img src={civicHills} alt="Green rolling civic landscape" className="absolute inset-0 h-full w-full object-cover" />
      <div className="absolute inset-0 bg-foreground/45" />
      <div className="relative z-10 grid min-h-screen place-items-center px-5 py-10">
        <section className="w-full max-w-md rounded-[1.5rem] border border-auth-border bg-foreground/55 p-6 text-auth-foreground shadow-glass backdrop-blur-xl transition duration-500 hover:bg-foreground/60 sm:p-8">
          <div className="mb-8 flex items-center justify-between">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-civic shadow-civic"><Leaf className="h-6 w-6" /></div>
            <span className="rounded-full border border-auth-border bg-auth-input/10 px-3 py-1 text-xs text-auth-muted backdrop-blur">CivicGreen</span>
          </div>
          <h1 className="text-4xl font-black tracking-normal">Report what matters.</h1>
          <p className="mt-3 text-sm leading-6 text-auth-muted">A modern civic issue platform for clean streets, safer blocks, and greener neighborhoods.</p>
          <form className="mt-8 space-y-4" onSubmit={submit}>
            {isSignup && <input className="w-full rounded-xl border border-auth-border bg-auth-input px-4 py-3 text-foreground outline-none ring-ring transition placeholder:text-muted-foreground focus:ring-2" value={name} onChange={(event) => setName(event.target.value)} placeholder="Display name" />}
            <input className="w-full rounded-xl border border-auth-border bg-auth-input px-4 py-3 text-foreground outline-none ring-ring transition placeholder:text-muted-foreground focus:ring-2" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Email" />
            <input className="w-full rounded-xl border border-auth-border bg-auth-input px-4 py-3 text-foreground outline-none ring-ring transition placeholder:text-muted-foreground focus:ring-2" type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Password" />
            <Button variant="civic" className="h-12 w-full" disabled={loading}>{loading ? <Loader2 className="animate-spin" /> : isSignup ? "Create account" : "Login"}</Button>
          </form>
          <div className="mt-5 flex items-center justify-between text-sm text-auth-muted">
            <button className="transition hover:text-auth-foreground" onClick={() => setIsSignup(!isSignup)}>{isSignup ? "Have an account? Login" : "New here? Sign up"}</button>
            <button className="transition hover:text-auth-foreground" onClick={() => onAuthenticated("offline@local.app")}>Offline demo</button>
          </div>
          <p className="mt-5 rounded-xl border border-auth-border bg-auth-input/10 p-3 text-xs text-auth-muted">{message}</p>
        </section>
      </div>
    </main>
  );
};

const Index = () => {
  const [session, setSession] = useState<Session | null>(null);
  const [authed, setAuthed] = useState(() => localStorage.getItem("civic-auth") === "true");
  const [role, setRole] = useState<Role>(() => (localStorage.getItem(ROLE_KEY) as Role) || "user");
  const [issues, setIssues] = useState<Issue[]>(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? JSON.parse(stored) : seedIssues;
  });
  const [view, setView] = useState<"map" | "kanban">("map");
  const [pendingPosition, setPendingPosition] = useState<[number, number] | null>(null);
  const [userPosition, setUserPosition] = useState<[number, number]>(CENTER);
  const [locationStatus, setLocationStatus] = useState("Detecting your location…");
  const [zoom, setZoom] = useState(13);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [votedIssueIds, setVotedIssueIds] = useState<string[]>(() => {
    const stored = localStorage.getItem(VOTES_KEY);
    return stored ? JSON.parse(stored) : [];
  });

  useEffect(() => {
    let mounted = true;
    if (!supabase) return;
    const { data: listener } = supabase.auth.onAuthStateChange((_event, currentSession) => {
      if (mounted) {
        setSession(currentSession);
        if (currentSession?.user.email) handleAuthenticated(currentSession.user.email);
      }
    });
    supabase.auth.getSession().then(({ data }) => { if (mounted) setSession(data.session); });
    return () => { mounted = false; listener.subscription.unsubscribe(); };
  }, []);

  useEffect(() => { localStorage.setItem(STORAGE_KEY, JSON.stringify(issues)); }, [issues]);
  useEffect(() => { localStorage.setItem(ROLE_KEY, role); }, [role]);
  useEffect(() => { localStorage.setItem(VOTES_KEY, JSON.stringify(votedIssueIds)); }, [votedIssueIds]);

  useEffect(() => {
    if (!navigator.geolocation) {
      setLocationStatus("Location unavailable. Showing default region.");
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const nextPosition: [number, number] = [position.coords.latitude, position.coords.longitude];
        setUserPosition(nextPosition);
        setLocationStatus("Showing issues near your current region.");
        setIssues((current) => {
          const regionalIssues = current.filter((issue) => kilometersBetween(nextPosition, [issue.latitude, issue.longitude]) <= REGION_RADIUS_KM);
          return regionalIssues.length ? regionalIssues : createRegionalSeeds(nextPosition);
        });
      },
      () => setLocationStatus("Allow location access to show only your region."),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 300000 },
    );
  }, []);

  const handleAuthenticated = (email: string) => {
    const nextRole: Role = email.toLowerCase() === "admin@gmail.com" ? "admin" : "user";
    setRole(nextRole);
    localStorage.setItem(ROLE_KEY, nextRole);
    localStorage.setItem("civic-auth", "true");
    setAuthed(true);
  };

  const regionalIssues = useMemo(() => issues.filter((issue) => kilometersBetween(userPosition, [issue.latitude, issue.longitude]) <= REGION_RADIUS_KM), [issues, userPosition]);
  const clusters = useMemo(() => kMeansClusters(regionalIssues, zoom), [regionalIssues, zoom]);
  const analytics = useMemo(() => {
    const resolved = regionalIssues.filter((issue) => issue.status === "resolved").length;
    const counts = regionalIssues.reduce<Record<Category, number>>((acc, issue) => ({ ...acc, [issue.category]: (acc[issue.category] || 0) + 1 }), {} as Record<Category, number>);
    const common = (Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || "infrastructure") as Category;
    return { total: regionalIssues.length, resolvedPct: regionalIssues.length ? Math.round((resolved / regionalIssues.length) * 100) : 0, common: categoryMeta[common].label };
  }, [regionalIssues]);

  const addIssue = (issue: Omit<Issue, "id" | "votes" | "timestamp" | "status">) => {
    setIssues((current) => [{ ...issue, id: crypto.randomUUID(), votes: 0, timestamp: Date.now(), status: "new" }, ...current]);
  };

  const pickIssuePosition = (lat: number, lng: number) => {
    if (kilometersBetween(userPosition, [lat, lng]) > REGION_RADIUS_KM) {
      setLocationStatus(`Please report within ${REGION_RADIUS_KM} km of your current region.`);
      return;
    }
    setPendingPosition([lat, lng]);
  };

  const updateStatus = (id: string, status: Status) => setIssues((current) => current.map((issue) => issue.id === id ? { ...issue, status } : issue));
  const toggleVote = (id: string) => {
    const alreadyVoted = votedIssueIds.includes(id);
    setIssues((current) => current.map((issue) => issue.id === id ? { ...issue, votes: Math.max(0, issue.votes + (alreadyVoted ? -1 : 1)) } : issue));
    setVotedIssueIds((current) => alreadyVoted ? current.filter((issueId) => issueId !== id) : [...current, id]);
  };

  if (!authed) return <AuthScreen onAuthenticated={handleAuthenticated} />;

  const visibleSingles = clusters.filter((cluster) => cluster.issues.length === 1).map((cluster) => cluster.issues[0]);
  const statuses: Status[] = ["new", "in_progress", "resolved"];
  const dashboardCards: Array<{ label: string; value: string | number; Icon: typeof BarChart3 }> = role === "admin"
    ? [
        { label: "Total issues", value: analytics.total, Icon: BarChart3 },
        { label: "Resolved", value: `${analytics.resolvedPct}%`, Icon: CheckCircle2 },
        { label: "Top category", value: analytics.common, Icon: Sparkles },
      ]
    : [
        { label: "Open reports", value: regionalIssues.filter((i) => i.status !== "resolved").length, Icon: AlertTriangle },
        { label: "Neighborhood votes", value: regionalIssues.reduce((s, i) => s + i.votes, 0), Icon: ThumbsUp },
        { label: "Issue clusters", value: clusters.filter((c) => c.issues.length > 1).length, Icon: ListChecks },
      ];

  return (
    <main className="min-h-screen bg-gradient-soft">
      <header className="sticky top-0 z-30 border-b border-border bg-background/86 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-4 sm:px-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-civic text-primary-foreground shadow-civic"><MapPin /></div>
            <div><h1 className="text-2xl font-black tracking-normal">CivicGreen</h1><p className="text-sm text-muted-foreground">Live civic issue reporting</p></div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="rounded-xl border border-border bg-card p-1 shadow-civic">
              <button className={`rounded-lg px-4 py-2 text-sm font-semibold transition ${view === "map" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`} onClick={() => setView("map")}>Map View</button>
              <button className={`rounded-lg px-4 py-2 text-sm font-semibold transition ${view === "kanban" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`} onClick={() => setView("kanban")}>Kanban</button>
            </div>
            <Button variant="outline" onClick={() => setRole(role === "admin" ? "user" : "admin")}><UserCog /> {role}</Button>
            <Button variant="ghost" size="icon" onClick={() => { localStorage.removeItem("civic-auth"); setAuthed(false); supabase?.auth.signOut(); }}><LogOut /></Button>
          </div>
        </div>
      </header>

      <section className="mx-auto grid max-w-7xl gap-4 px-4 py-5 sm:px-6 lg:grid-cols-3">
        {dashboardCards.map(({ label, value, Icon }) => (
          <article key={label} className="rounded-2xl border border-border bg-card p-5 shadow-civic transition duration-300 hover:-translate-y-1 hover:shadow-civic-lg">
            <div className="flex items-center justify-between"><span className="text-sm font-semibold text-muted-foreground">{label}</span><Icon className="h-5 w-5 text-primary" /></div>
            <strong className="mt-3 block text-3xl font-black">{value}</strong>
          </article>
        ))}
      </section>

      {view === "map" ? (
        <section className="mx-auto grid max-w-7xl gap-4 px-4 pb-8 sm:px-6 lg:grid-cols-[320px_minmax(0,1fr)]">
          <aside className="order-2 max-h-[70vh] overflow-y-auto rounded-[1.5rem] border border-border bg-card/90 p-4 shadow-civic lg:order-1">
            <div className="mb-4">
              <p className="text-xs font-bold uppercase text-primary">K-means groups</p>
              <h2 className="text-xl font-black">Grouped requests</h2>
            </div>
            <div className="space-y-3">
              {clusters.map((cluster, index) => (
                <article key={cluster.id} className="rounded-2xl border border-border bg-secondary/70 p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <strong>Group {index + 1}</strong>
                    <span className="rounded-full bg-card px-2 py-1 text-xs font-bold">{cluster.issues.length} request{cluster.issues.length === 1 ? "" : "s"}</span>
                  </div>
                  <div className="space-y-2">
                    {cluster.issues.map((issue) => (
                      <div key={issue.id} className="rounded-xl bg-card/80 p-3 text-sm">
                        <div className="flex items-start justify-between gap-2">
                          <span className="font-bold">{issue.title}</span>
                          <span className="text-xs font-semibold text-primary">{issue.votes} votes</span>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">{categoryMeta[issue.category].label} · {statusMeta[issue.status].label}</p>
                        {role === "admin" && (
                          <select className="mt-2 w-full rounded-lg border border-border bg-background px-2 py-1 text-xs font-semibold outline-none ring-ring focus:ring-2" value={issue.status} onChange={(event) => updateStatus(issue.id, event.target.value as Status)}>
                            {statuses.map((status) => <option key={status} value={status}>{statusMeta[status].label}</option>)}
                          </select>
                        )}
                      </div>
                    ))}
                  </div>
                </article>
              ))}
            </div>
          </aside>
          <div className="relative order-1 h-[70vh] min-h-[520px] min-w-80 overflow-hidden rounded-[1.5rem] border border-border bg-secondary shadow-civic-lg lg:order-2">
            <MapContainer center={userPosition} zoom={14} className="h-full min-h-[520px] w-full rounded-[inherit]" style={{ height: "100%", minHeight: 520, width: "100%" }}>
              <TileLayer attribution='&copy; OpenStreetMap contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
              <MapClickHandler onPick={pickIssuePosition} />
              <MapCenterHandler center={userPosition} />
              <MapResizeHandler />
              <ZoomWatcher onZoom={setZoom} />
              <Marker position={userPosition} icon={createIcon("marker-user", "") }><Popup><div className="p-3 text-sm font-bold">Your current region</div></Popup></Marker>
              {pendingPosition && <Marker position={pendingPosition} icon={createIcon("marker-greenery", "+")}><Popup><IssueForm position={pendingPosition} onCreate={addIssue} onClose={() => setPendingPosition(null)} /></Popup></Marker>}
              {clusters.map((cluster) => <ClusterMarker key={cluster.id} cluster={cluster} />)}
              {visibleSingles.map((issue) => {
                const meta = categoryMeta[issue.category];
                return <Marker key={issue.id} position={[issue.latitude, issue.longitude]} icon={createIcon(meta.marker, "")}> <Popup><div className="w-72 p-4"><div className="mb-2 flex items-start justify-between gap-3"><div><p className="font-bold">{issue.title}</p><p className="text-xs text-muted-foreground">{meta.label}</p></div><span className={`rounded-full px-2 py-1 text-xs font-semibold ${statusMeta[issue.status].tone}`}>{statusMeta[issue.status].label}</span></div><p className="text-sm text-muted-foreground">{issue.description}</p>{role === "admin" && <select className="mt-3 w-full rounded-lg border border-border bg-background px-2 py-2 text-sm font-semibold outline-none ring-ring focus:ring-2" value={issue.status} onChange={(event) => updateStatus(issue.id, event.target.value as Status)}>{statuses.map((status) => <option key={status} value={status}>{statusMeta[status].label}</option>)}</select>}<div className="mt-4 flex items-center justify-between"><span className="text-sm font-bold">{issue.votes} votes</span><Button variant={votedIssueIds.includes(issue.id) ? "outline" : "civic"} size="sm" onClick={() => toggleVote(issue.id)}><ThumbsUp /> {votedIssueIds.includes(issue.id) ? "Voted" : "Upvote"}</Button></div></div></Popup></Marker>;
              })}
            </MapContainer>
            <div className="absolute left-4 top-4 z-[500] max-w-xs rounded-2xl border border-border bg-card/90 px-4 py-3 text-sm font-semibold text-foreground shadow-civic backdrop-blur">
              {locationStatus}
            </div>
            <Button variant="outline" size="icon" className="absolute bottom-24 right-6 z-[500] h-12 w-12 rounded-full bg-card/95" onClick={() => navigator.geolocation?.getCurrentPosition((position) => setUserPosition([position.coords.latitude, position.coords.longitude]))}><LocateFixed /></Button>
            <Button variant="civic" size="icon" className="absolute bottom-6 right-6 z-[500] h-14 w-14 rounded-full" onClick={() => setPendingPosition(userPosition)}><Plus /></Button>
          </div>
        </section>
      ) : (
        <section className="mx-auto grid max-w-7xl gap-4 px-4 pb-8 sm:px-6 lg:grid-cols-3">
          {statuses.map((status) => (
            <div key={status} className="min-h-[480px] rounded-[1.5rem] border border-border bg-card/80 p-4 shadow-civic" onDragOver={(event) => role === "admin" && event.preventDefault()} onDrop={() => { if (role === "admin" && draggingId) updateStatus(draggingId, status); setDraggingId(null); }}>
              <div className="mb-4 flex items-center justify-between"><h2 className="font-black">{statusMeta[status].label}</h2><span className="rounded-full bg-secondary px-3 py-1 text-xs font-bold">{regionalIssues.filter((i) => i.status === status).length}</span></div>
              <div className="space-y-3">
                {regionalIssues.filter((issue) => issue.status === status).map((issue) => {
                  const Icon = categoryMeta[issue.category].icon;
                  return <article key={issue.id} draggable={role === "admin"} onDragStart={() => setDraggingId(issue.id)} className="rounded-2xl border border-border bg-secondary/70 p-4 shadow-civic transition duration-300 hover:-translate-y-1 hover:bg-secondary"><div className="mb-3 flex items-start justify-between gap-3"><Icon className="h-5 w-5 text-primary" /><span className="text-xs font-bold text-muted-foreground">{issue.votes} votes</span></div><h3 className="font-bold">{issue.title}</h3><p className="mt-2 text-sm text-muted-foreground">{issue.description}</p><p className="mt-3 text-xs font-semibold text-primary">{categoryMeta[issue.category].label}</p></article>;
                })}
              </div>
            </div>
          ))}
        </section>
      )}
    </main>
  );
};

export default Index;
