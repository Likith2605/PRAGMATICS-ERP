import { Fragment, useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import {
  Plus,
  FolderKanban,
  FileCheck2,
  Eye,
  PencilLine,
  Trash2,
  Copy,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FilePlus2
} from 'lucide-react';

import api from '../../services/ballooningApi';
import { drawingNumberFor } from '../../utils/ballooning/balloonUtils';

const getProjectNumber = (project) => project?.projectNumber || project?.projectId || '-';
const getPartNumber = (project) => project?.partNumber || project?.partName || '-';

export default function Dashboard() {
  const navigate = useNavigate();

  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(null);

  /* Expandable per-drawing status: { [projectId]: { drawings, balloons, loading } } */
  const [drawingDetails, setDrawingDetails] = useState({});
  const [expandedProjectId, setExpandedProjectId] = useState(null);

  // --------------------------------------------------
  // LOAD PROJECTS
  // --------------------------------------------------
  const loadProjects = async () => {
    try {
      setLoading(true);

      const data = await api.get('/projects');

      setProjects(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error('Failed to load projects:', error);
      setProjects([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadProjects();
  }, []);

  // --------------------------------------------------
  // EXPAND → LOAD DRAWINGS + BALLOONS
  // --------------------------------------------------
  const toggleProjectDrawings = async (project) => {
    const projectId = project._id;

    setExpandedProjectId((current) =>
      current === projectId ? null : projectId
    );

    if (
      expandedProjectId === projectId ||
      drawingDetails[projectId]
    ) {
      return;
    }

    setDrawingDetails((prev) => ({
      ...prev,
      [projectId]: { drawings: [], balloons: [], loading: true }
    }));

    try {
      const [drawings, balloons] = await Promise.all([
        api.get(`/projects/${projectId}/drawings`).catch(() => []),
        api.get(`/projects/${projectId}/balloons`).catch(() => [])
      ]);

      setDrawingDetails((prev) => ({
        ...prev,
        [projectId]: {
          drawings: Array.isArray(drawings) ? drawings : [],
          balloons: Array.isArray(balloons) ? balloons : [],
          loading: false
        }
      }));
    } catch (error) {
      console.error('Failed to load drawing status:', error);
      setDrawingDetails((prev) => ({
        ...prev,
        [projectId]: { drawings: [], balloons: [], loading: false }
      }));
    }
  };

  const countBalloonsForDrawing = (details, drawingId, allDrawings) => {
    const legacyOwnerId =
      Array.isArray(allDrawings) && allDrawings.length > 0
        ? allDrawings[0]._id
        : null;

    return (details?.balloons || []).filter((balloon) => {
      const owner = balloon?.drawingId || legacyOwnerId;
      return owner === drawingId;
    }).length;
  };

  // --------------------------------------------------
  // OPEN PROJECT / DRAWING
  // --------------------------------------------------
  const openProject = (id) => {
    navigate(`/ballooning/project/${id}`);
  };

  const openDrawing = (projectId, drawingId) => {
    navigate(`/ballooning/project/${projectId}?drawing=${drawingId}`);
  };

  const addDrawing = (projectId) => {
    navigate(`/ballooning/project/${projectId}?newDrawing=1`);
  };

  // --------------------------------------------------
  // EDIT PROJECT
  // --------------------------------------------------
  const editProject = (id) => {
    navigate(`/ballooning/new?edit=${id}`);
  };

  // --------------------------------------------------
  // DELETE PROJECT
  // --------------------------------------------------
  const deleteProject = async (project) => {
    const confirmed = window.confirm(
      `Are you sure you want to delete project "${getProjectNumber(project)}"?\n\nThis action cannot be undone.`
    );

    if (!confirmed) {
      return;
    }

    try {
      setActionLoading(project._id);

      await api.delete(`/projects/${project._id}`);

      // Remove deleted project immediately from UI
      setProjects((currentProjects) =>
        currentProjects.filter((p) => p._id !== project._id)
      );

      alert(`Project ${getProjectNumber(project)} deleted successfully.`);
    } catch (error) {
      console.error('Delete project failed:', error);

      alert(
        error?.response?.data?.message ||
        'Unable to delete the project. Please try again.'
      );
    } finally {
      setActionLoading(null);
    }
  };

  // --------------------------------------------------
  // DUPLICATE / COPY PROJECT
  // --------------------------------------------------
  const copyProject = async (project) => {
    const confirmed = window.confirm(
      `Create a copy of project "${getProjectNumber(project)}?"`
    );

    if (!confirmed) {
      return;
    }

    try {
      setActionLoading(project._id);

      /*
       * The backend needs to support:
       * POST /projects/:id/duplicate
       *
       * with the original project ID.
       */

      const copiedProject = await api.post(
        `/projects/${project._id}/duplicate`
      );

      // If backend returns the newly created project
      if (copiedProject) {
        setProjects((currentProjects) => [
          copiedProject,
          ...currentProjects
        ]);
      } else {
        await loadProjects();
      }

      alert('Project copied successfully.');
    } catch (error) {
      console.error('Copy project failed:', error);

      alert(
        error?.response?.data?.message ||
        'Copy operation is not available yet in the backend.'
      );
    } finally {
      setActionLoading(null);
    }
  };

  // --------------------------------------------------
  // DASHBOARD CARDS
  // --------------------------------------------------
  const cards = [
    {
      label: 'Total Projects',
      value: projects.length,
      icon: FolderKanban
    },
    {
      label: 'Draft Projects',
      value: projects.filter((p) => p.status === 'Draft').length,
      icon: FileCheck2
    },
    {
      label: 'Under Review',
      value: projects.filter((p) => p.status === 'Under Review').length,
      icon: Eye
    },
    {
      label: 'Approved Projects',
      value: projects.filter((p) => p.status === 'Approved').length,
      icon: CheckCircle2
    }
  ];

  // --------------------------------------------------
  // UI
  // --------------------------------------------------
  return (
    <div className="space-y-6">

      {/* HEADER */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">
            Dashboard
          </h1>

          <p className="text-slate-600">
            Track projects, ballooning status, and inspection progress.
          </p>
        </div>

        <Link
          to="/ballooning/new"
          className="flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-white hover:bg-slate-800"
        >
          <Plus size={16} />
          New Inspection Project
        </Link>
      </div>

      {/* DASHBOARD CARDS */}
      <div className="grid gap-4 md:grid-cols-4">

        {cards.map((card) => {
          const Icon = card.icon;

          return (
            <div
              key={card.label}
              className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
            >
              <div className="flex items-center justify-between text-slate-500">
                <span>{card.label}</span>
                <Icon size={18} />
              </div>

              <div className="mt-3 text-3xl font-semibold text-slate-900">
                {card.value}
              </div>
            </div>
          );
        })}

      </div>

      {/* PROJECT TABLE */}
      <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">

        <div className="px-4 py-3 border-b text-slate-700 font-semibold">
          Recent Projects
        </div>

        <div className="overflow-x-auto">

          <table className="w-full text-sm">

            <thead className="bg-slate-50 text-slate-600">

              <tr>
                <th className="px-4 py-3 text-left">
                  Project Number
                </th>

                <th className="px-4 py-3 text-left">
                  Customer
                </th>

                <th className="px-4 py-3 text-left">
                  Part Number
                </th>

                <th className="px-4 py-3 text-left">
                  Drawing Number
                </th>

                <th className="px-4 py-3 text-left">
                  Revision
                </th>

                <th className="px-4 py-3 text-left">
                  Status
                </th>

                <th className="px-4 py-3 text-left">
                  Created
                </th>

                <th className="px-4 py-3 text-left">
                  Created By
                </th>

                <th className="px-4 py-3 text-left">
                  Actions
                </th>
              </tr>

            </thead>

            <tbody>

              {loading ? (

                <tr>
                  <td
                    colSpan="9"
                    className="px-4 py-8 text-center text-slate-500"
                  >
                    Loading projects...
                  </td>
                </tr>

              ) : projects.length === 0 ? (

                <tr>
                  <td
                    colSpan="9"
                    className="px-4 py-8 text-center text-slate-500"
                  >
                    No projects found.
                  </td>
                </tr>

              ) : (

                projects.map((project) => {
                  const isExpanded =
                    expandedProjectId === project._id;

                  const details =
                    drawingDetails[project._id] || null;

                  return (
                  <Fragment key={project._id}>
                  <tr
                    className="border-t hover:bg-slate-50"
                  >

                    <td className="px-4 py-3 font-medium">
                      <button
                        type="button"
                        onClick={() => toggleProjectDrawings(project)}
                        title="Show drawings in this project"
                        className="flex items-center gap-1 text-left"
                      >
                        {isExpanded ? (
                          <ChevronDown size={14} className="text-slate-400" />
                        ) : (
                          <ChevronRight size={14} className="text-slate-400" />
                        )}

                        <span>{getProjectNumber(project)}</span>
                      </button>
                    </td>

                    <td className="px-4 py-3">
                      {project.customerName}
                    </td>

                    <td className="px-4 py-3">
                      {getPartNumber(project)}
                    </td>

                    <td className="px-4 py-3">
                      {project.drawingNumber}
                    </td>

                    <td className="px-4 py-3">
                      {project.revision}
                    </td>

                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${
                          project.status === 'Approved'
                            ? 'bg-green-100 text-green-700'
                            : project.status === 'Under Review'
                            ? 'bg-yellow-100 text-yellow-700'
                            : 'bg-slate-100 text-slate-700'
                        }`}
                      >
                        {project.status}
                      </span>
                    </td>

                    <td className="px-4 py-3">
                      {project.createdAt
                        ? new Date(project.createdAt).toLocaleDateString()
                        : '-'}
                    </td>

                    <td className="px-4 py-3">
                      {project.createdBy || '-'}
                    </td>

                    {/* ACTIONS */}
                    <td className="px-4 py-3">

                      <div className="flex items-center gap-2">

                        {/* OPEN */}
                        <button
                          onClick={() => openProject(project._id)}
                          title="Open project"
                          className="rounded border px-2 py-1 text-slate-700 hover:bg-slate-100"
                        >
                          Open
                        </button>

                        {/* NEW DRAWING */}
                        <button
                          onClick={() => addDrawing(project._id)}
                          title="Add another drawing to this project"
                          className="rounded border p-2 text-slate-700 hover:bg-slate-100"
                        >
                          <FilePlus2 size={14} />
                        </button>

                        {/* EDIT */}
                        <button
                          onClick={() => editProject(project._id)}
                          title="Edit project"
                          disabled={actionLoading === project._id}
                          className="rounded border p-2 text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                        >
                          <PencilLine size={14} />
                        </button>

                        {/* DELETE */}
                        <button
                          onClick={() => deleteProject(project)}
                          title="Delete project"
                          disabled={actionLoading === project._id}
                          className="rounded border p-2 text-red-600 hover:bg-red-50 disabled:opacity-50"
                        >
                          <Trash2 size={14} />
                        </button>

                        {/* COPY */}
                        <button
                          onClick={() => copyProject(project)}
                          title="Copy project"
                          disabled={actionLoading === project._id}
                          className="rounded border p-2 text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                        >
                          <Copy size={14} />
                        </button>

                      </div>

                    </td>

                  </tr>

                  {/* PER-DRAWING STATUS */}
                  {isExpanded ? (
                    <tr className="border-t bg-slate-50">
                      <td colSpan="9" className="px-4 py-3">
                        {details?.loading ? (
                          <div className="text-sm text-slate-500">
                            Loading drawings...
                          </div>
                        ) : !details || details.drawings.length === 0 ? (
                          <div className="text-sm text-slate-500">
                            No drawings uploaded for this project yet.
                          </div>
                        ) : (
                          <div className="overflow-hidden rounded border border-slate-200 bg-white">
                            <table className="w-full text-sm">
                              <thead className="bg-white text-xs uppercase tracking-wide text-slate-500">
                                <tr>
                                  <th className="px-4 py-2 text-left">Drawing No</th>
                                  <th className="px-4 py-2 text-left">File</th>
                                  <th className="px-4 py-2 text-left">Balloons</th>
                                  <th className="px-4 py-2 text-left">Status</th>
                                  <th className="px-4 py-2 text-left">Uploaded</th>
                                  <th className="px-4 py-2 text-left">Actions</th>
                                </tr>
                              </thead>
                              <tbody>
                                {details.drawings.map((drawing) => {
                                  const balloonCount = countBalloonsForDrawing(
                                    details,
                                    drawing._id,
                                    details.drawings
                                  );

                                  return (
                                    <tr key={drawing._id} className="border-t border-slate-100">
                                      <td className="px-4 py-2 font-medium text-slate-800">
                                        {drawingNumberFor(drawing) || '-'}
                                      </td>
                                      <td className="px-4 py-2 text-slate-600">
                                        {drawing.fileName}
                                      </td>
                                      <td className="px-4 py-2 text-slate-700">
                                        {balloonCount}
                                      </td>
                                      <td className="px-4 py-2">
                                        <span
                                          className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                                            balloonCount > 0
                                              ? 'bg-green-100 text-green-700'
                                              : 'bg-slate-100 text-slate-600'
                                          }`}
                                        >
                                          {balloonCount > 0
                                            ? 'Ballooned'
                                            : 'Not ballooned'}
                                        </span>
                                      </td>
                                      <td className="px-4 py-2 text-slate-500">
                                        {drawing.uploadedAt
                                          ? new Date(drawing.uploadedAt).toLocaleDateString()
                                          : '-'}
                                      </td>
                                      <td className="px-4 py-2">
                                        <button
                                          onClick={() =>
                                            openDrawing(project._id, drawing._id)
                                          }
                                          title="Open this drawing in the workspace"
                                          className="rounded border px-2 py-1 text-slate-700 hover:bg-slate-100"
                                        >
                                          Balloon
                                        </button>
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </td>
                    </tr>
                  ) : null}
                  </Fragment>
                  );
                })

              )}

            </tbody>

          </table>

        </div>

      </div>

    </div>
  );
}