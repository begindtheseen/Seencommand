// Turns on activity → notification for this process (server, board meeting, build runner). Imported only by
// entry points, so tests and libraries never write notifications as a side effect.
import { enableActivityNotifications } from './activity.mjs';
import { notify } from './notifications.mjs';
enableActivityNotifications(notify);
// Failures → brain tickets (lib/ticket-wire.mjs): the same entry points, the same no-side-effects-in-tests rule.
import './ticket-wire.mjs';
