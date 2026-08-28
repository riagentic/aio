// browser-air-router: the router components live in src/air/router.ts with an
// injected boot hook; the browser wires `ensureConnected` in as that hook so a
// routed page connects exactly as before.
import { _setRouterBoot } from "../air/router.ts";
import { _installRouterListeners } from "../air/router-core.ts";
import { ensureConnected } from "./browser-protocol.ts";
_setRouterBoot(ensureConnected);
_installRouterListeners();
export {
  Link,
  NavLink,
  Outlet,
  page,
  Redirect,
  Route,
  useNavigate,
  useRoute,
} from "../air/router.ts";
