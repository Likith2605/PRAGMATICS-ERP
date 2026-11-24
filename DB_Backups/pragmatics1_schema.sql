--
-- PostgreSQL database dump
--

\restrict ehXNCB2pfvV2aBzrgoVyMT1WdwExEB7mUIbTAMT24yCeqjiIcbjojhTga6wU9UN

-- Dumped from database version 18.6
-- Dumped by pg_dump version 18.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: ballooning_approvals; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.ballooning_approvals (
    id text NOT NULL,
    project_id text NOT NULL,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL
);


ALTER TABLE public.ballooning_approvals OWNER TO postgres;

--
-- Name: ballooning_balloons; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.ballooning_balloons (
    id text NOT NULL,
    project_id text NOT NULL,
    drawing_id text,
    number integer NOT NULL,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT ballooning_balloons_number_check CHECK ((number > 0))
);


ALTER TABLE public.ballooning_balloons OWNER TO postgres;

--
-- Name: ballooning_characteristics; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.ballooning_characteristics (
    id text NOT NULL,
    project_id text NOT NULL,
    drawing_id text,
    balloon_id text,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.ballooning_characteristics OWNER TO postgres;

--
-- Name: ballooning_drawings; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.ballooning_drawings (
    id text NOT NULL,
    project_id text NOT NULL,
    file_name text NOT NULL,
    drawing_no text DEFAULT ''::text NOT NULL,
    storage_name text NOT NULL,
    page_count integer DEFAULT 1 NOT NULL,
    uploaded_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT ballooning_drawings_page_count_check CHECK ((page_count > 0))
);


ALTER TABLE public.ballooning_drawings OWNER TO postgres;

--
-- Name: ballooning_inspections; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.ballooning_inspections (
    id text NOT NULL,
    project_id text NOT NULL,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.ballooning_inspections OWNER TO postgres;

--
-- Name: ballooning_projects; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.ballooning_projects (
    id text NOT NULL,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


ALTER TABLE public.ballooning_projects OWNER TO postgres;

--
-- Name: erp_state; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.erp_state (
    storage_key text NOT NULL,
    data jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.erp_state OWNER TO postgres;

--
-- Name: file_blobs; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.file_blobs (
    id text NOT NULL,
    file_name text DEFAULT 'document'::text NOT NULL,
    mime_type text DEFAULT 'application/octet-stream'::text NOT NULL,
    size_bytes bigint DEFAULT 0 NOT NULL,
    scope text DEFAULT 'generic'::text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    content bytea NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT file_blobs_size_bytes_check CHECK ((size_bytes >= 0))
);


ALTER TABLE public.file_blobs OWNER TO postgres;

--
-- Name: module_records; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.module_records (
    storage_key text NOT NULL,
    record_id text NOT NULL,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by text DEFAULT ''::text NOT NULL
);


ALTER TABLE public.module_records OWNER TO postgres;

--
-- Name: quality_checks; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.quality_checks (
    id text NOT NULL,
    drawing_id text NOT NULL,
    checked_by text DEFAULT ''::text NOT NULL,
    inspector_name text DEFAULT ''::text NOT NULL,
    checked_at timestamp with time zone DEFAULT now() NOT NULL,
    result text DEFAULT 'Pending'::text NOT NULL,
    instrument text DEFAULT ''::text NOT NULL,
    inspector_notes text DEFAULT ''::text NOT NULL,
    deleted integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.quality_checks OWNER TO postgres;

--
-- Name: quality_dimensions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.quality_dimensions (
    id text NOT NULL,
    drawing_id text NOT NULL,
    dim_no integer NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    nominal double precision DEFAULT 0 NOT NULL,
    nominal_text text DEFAULT ''::text NOT NULL,
    tol_upper double precision DEFAULT 0 NOT NULL,
    tol_lower double precision DEFAULT 0 NOT NULL,
    deleted integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.quality_dimensions OWNER TO postgres;

--
-- Name: quality_dispatches; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.quality_dispatches (
    id text NOT NULL,
    dispatch_no text DEFAULT ''::text NOT NULL,
    drawing_id text NOT NULL,
    drawing_no text DEFAULT ''::text NOT NULL,
    part_name text DEFAULT ''::text NOT NULL,
    po_no text DEFAULT ''::text NOT NULL,
    invoice_no text DEFAULT ''::text NOT NULL,
    qty integer DEFAULT 0 NOT NULL,
    dispatched_by text DEFAULT ''::text NOT NULL,
    dispatched_at timestamp with time zone DEFAULT now() NOT NULL,
    notes text DEFAULT ''::text NOT NULL,
    deleted integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.quality_dispatches OWNER TO postgres;

--
-- Name: quality_drawings; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.quality_drawings (
    id text NOT NULL,
    drawing_no text DEFAULT ''::text NOT NULL,
    part_name text DEFAULT ''::text NOT NULL,
    customer text DEFAULT ''::text NOT NULL,
    revision text DEFAULT ''::text NOT NULL,
    material text DEFAULT ''::text NOT NULL,
    unit text DEFAULT 'mm'::text NOT NULL,
    notes text DEFAULT ''::text NOT NULL,
    po_no text DEFAULT ''::text NOT NULL,
    qty integer DEFAULT 0 NOT NULL,
    treatment text DEFAULT ''::text NOT NULL,
    hardness text DEFAULT ''::text NOT NULL,
    image_uri text DEFAULT ''::text NOT NULL,
    deleted integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.quality_drawings OWNER TO postgres;

--
-- Name: quality_instruments; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.quality_instruments (
    id text NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    deleted integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.quality_instruments OWNER TO postgres;

--
-- Name: quality_measurements; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.quality_measurements (
    id text NOT NULL,
    check_id text NOT NULL,
    dimension_id text NOT NULL,
    sample1 double precision,
    sample2 double precision,
    sample3 double precision,
    sample4 double precision,
    sample5 double precision,
    sample6 double precision,
    sample7 double precision,
    sample8 double precision,
    sample9 double precision,
    sample10 double precision,
    remarks text DEFAULT ''::text NOT NULL,
    pass integer,
    instrument text DEFAULT ''::text NOT NULL,
    sample_status text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.quality_measurements OWNER TO postgres;

--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.schema_migrations (
    version text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.schema_migrations OWNER TO postgres;

--
-- Name: tally_export_files; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.tally_export_files (
    id text NOT NULL,
    export_id text NOT NULL,
    file_name text NOT NULL,
    file_type text NOT NULL,
    content bytea NOT NULL,
    content_type text DEFAULT 'application/xml'::text NOT NULL,
    size_bytes bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.tally_export_files OWNER TO postgres;

--
-- Name: tally_export_history; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.tally_export_history (
    id text NOT NULL,
    export_date timestamp with time zone DEFAULT now() NOT NULL,
    export_type text DEFAULT 'tally_xml'::text NOT NULL,
    date_from date NOT NULL,
    date_to date NOT NULL,
    transaction_types jsonb DEFAULT '[]'::jsonb NOT NULL,
    masters_included jsonb DEFAULT '[]'::jsonb NOT NULL,
    record_counts jsonb DEFAULT '{}'::jsonb NOT NULL,
    file_names jsonb DEFAULT '[]'::jsonb NOT NULL,
    export_status text DEFAULT 'generated'::text NOT NULL,
    generated_by text DEFAULT ''::text NOT NULL,
    validation_summary jsonb DEFAULT '{}'::jsonb NOT NULL,
    notes text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    total_amount numeric(14,2) DEFAULT 0 NOT NULL
);


ALTER TABLE public.tally_export_history OWNER TO postgres;

--
-- Name: ballooning_approvals ballooning_approvals_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.ballooning_approvals
    ADD CONSTRAINT ballooning_approvals_pkey PRIMARY KEY (id);


--
-- Name: ballooning_balloons ballooning_balloons_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.ballooning_balloons
    ADD CONSTRAINT ballooning_balloons_pkey PRIMARY KEY (id);


--
-- Name: ballooning_characteristics ballooning_characteristics_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.ballooning_characteristics
    ADD CONSTRAINT ballooning_characteristics_pkey PRIMARY KEY (id);


--
-- Name: ballooning_drawings ballooning_drawings_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.ballooning_drawings
    ADD CONSTRAINT ballooning_drawings_pkey PRIMARY KEY (id);


--
-- Name: ballooning_inspections ballooning_inspections_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.ballooning_inspections
    ADD CONSTRAINT ballooning_inspections_pkey PRIMARY KEY (id);


--
-- Name: ballooning_inspections ballooning_inspections_project_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.ballooning_inspections
    ADD CONSTRAINT ballooning_inspections_project_id_key UNIQUE (project_id);


--
-- Name: ballooning_projects ballooning_projects_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.ballooning_projects
    ADD CONSTRAINT ballooning_projects_pkey PRIMARY KEY (id);


--
-- Name: erp_state erp_state_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.erp_state
    ADD CONSTRAINT erp_state_pkey PRIMARY KEY (storage_key);


--
-- Name: file_blobs file_blobs_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.file_blobs
    ADD CONSTRAINT file_blobs_pkey PRIMARY KEY (id);


--
-- Name: module_records module_records_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.module_records
    ADD CONSTRAINT module_records_pkey PRIMARY KEY (storage_key, record_id);


--
-- Name: quality_checks quality_checks_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.quality_checks
    ADD CONSTRAINT quality_checks_pkey PRIMARY KEY (id);


--
-- Name: quality_dimensions quality_dimensions_drawing_id_dim_no_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.quality_dimensions
    ADD CONSTRAINT quality_dimensions_drawing_id_dim_no_key UNIQUE (drawing_id, dim_no);


--
-- Name: quality_dimensions quality_dimensions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.quality_dimensions
    ADD CONSTRAINT quality_dimensions_pkey PRIMARY KEY (id);


--
-- Name: quality_dispatches quality_dispatches_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.quality_dispatches
    ADD CONSTRAINT quality_dispatches_pkey PRIMARY KEY (id);


--
-- Name: quality_drawings quality_drawings_drawing_no_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.quality_drawings
    ADD CONSTRAINT quality_drawings_drawing_no_key UNIQUE (drawing_no);


--
-- Name: quality_drawings quality_drawings_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.quality_drawings
    ADD CONSTRAINT quality_drawings_pkey PRIMARY KEY (id);


--
-- Name: quality_instruments quality_instruments_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.quality_instruments
    ADD CONSTRAINT quality_instruments_pkey PRIMARY KEY (id);


--
-- Name: quality_measurements quality_measurements_check_id_dimension_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.quality_measurements
    ADD CONSTRAINT quality_measurements_check_id_dimension_id_key UNIQUE (check_id, dimension_id);


--
-- Name: quality_measurements quality_measurements_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.quality_measurements
    ADD CONSTRAINT quality_measurements_pkey PRIMARY KEY (id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: tally_export_files tally_export_files_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tally_export_files
    ADD CONSTRAINT tally_export_files_pkey PRIMARY KEY (id);


--
-- Name: tally_export_history tally_export_history_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tally_export_history
    ADD CONSTRAINT tally_export_history_pkey PRIMARY KEY (id);


--
-- Name: ballooning_approvals_project_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX ballooning_approvals_project_idx ON public.ballooning_approvals USING btree (project_id, created_at DESC);


--
-- Name: ballooning_balloons_drawing_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX ballooning_balloons_drawing_idx ON public.ballooning_balloons USING btree (drawing_id);


--
-- Name: ballooning_balloons_drawing_number_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX ballooning_balloons_drawing_number_idx ON public.ballooning_balloons USING btree (drawing_id, number);


--
-- Name: ballooning_balloons_project_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX ballooning_balloons_project_idx ON public.ballooning_balloons USING btree (project_id, number);


--
-- Name: ballooning_characteristics_balloon_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX ballooning_characteristics_balloon_idx ON public.ballooning_characteristics USING btree (balloon_id);


--
-- Name: ballooning_characteristics_project_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX ballooning_characteristics_project_idx ON public.ballooning_characteristics USING btree (project_id);


--
-- Name: ballooning_drawings_project_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX ballooning_drawings_project_idx ON public.ballooning_drawings USING btree (project_id, uploaded_at DESC);


--
-- Name: ballooning_projects_drawing_no_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX ballooning_projects_drawing_no_idx ON public.ballooning_projects USING btree (((data ->> 'drawingNumber'::text)));


--
-- Name: ballooning_projects_status_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX ballooning_projects_status_idx ON public.ballooning_projects USING btree (((data ->> 'status'::text)));


--
-- Name: erp_state_key_prefix_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX erp_state_key_prefix_idx ON public.erp_state USING btree (storage_key text_pattern_ops);


--
-- Name: erp_state_updated_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX erp_state_updated_idx ON public.erp_state USING btree (updated_at DESC);


--
-- Name: file_blobs_scope_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX file_blobs_scope_idx ON public.file_blobs USING btree (scope, updated_at DESC);


--
-- Name: module_records_key_updated_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX module_records_key_updated_idx ON public.module_records USING btree (storage_key, updated_at DESC);


--
-- Name: quality_checks_drawing_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX quality_checks_drawing_idx ON public.quality_checks USING btree (drawing_id, checked_at DESC);


--
-- Name: quality_dimensions_drawing_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX quality_dimensions_drawing_idx ON public.quality_dimensions USING btree (drawing_id, dim_no);


--
-- Name: quality_dispatches_drawing_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX quality_dispatches_drawing_idx ON public.quality_dispatches USING btree (drawing_id, dispatched_at DESC);


--
-- Name: quality_measurements_check_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX quality_measurements_check_idx ON public.quality_measurements USING btree (check_id, dimension_id);


--
-- Name: tally_export_files_export_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX tally_export_files_export_idx ON public.tally_export_files USING btree (export_id, file_type);


--
-- Name: tally_export_history_amount_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX tally_export_history_amount_idx ON public.tally_export_history USING btree (total_amount);


--
-- Name: tally_export_history_date_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX tally_export_history_date_idx ON public.tally_export_history USING btree (export_date DESC);


--
-- Name: tally_export_history_status_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX tally_export_history_status_idx ON public.tally_export_history USING btree (export_status);


--
-- Name: tally_export_history_type_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX tally_export_history_type_idx ON public.tally_export_history USING btree (export_type);


--
-- Name: ballooning_approvals ballooning_approvals_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.ballooning_approvals
    ADD CONSTRAINT ballooning_approvals_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.ballooning_projects(id) ON DELETE CASCADE;


--
-- Name: ballooning_balloons ballooning_balloons_drawing_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.ballooning_balloons
    ADD CONSTRAINT ballooning_balloons_drawing_id_fkey FOREIGN KEY (drawing_id) REFERENCES public.ballooning_drawings(id) ON DELETE CASCADE;


--
-- Name: ballooning_balloons ballooning_balloons_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.ballooning_balloons
    ADD CONSTRAINT ballooning_balloons_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.ballooning_projects(id) ON DELETE CASCADE;


--
-- Name: ballooning_characteristics ballooning_characteristics_balloon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.ballooning_characteristics
    ADD CONSTRAINT ballooning_characteristics_balloon_id_fkey FOREIGN KEY (balloon_id) REFERENCES public.ballooning_balloons(id) ON DELETE CASCADE;


--
-- Name: ballooning_characteristics ballooning_characteristics_drawing_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.ballooning_characteristics
    ADD CONSTRAINT ballooning_characteristics_drawing_id_fkey FOREIGN KEY (drawing_id) REFERENCES public.ballooning_drawings(id) ON DELETE CASCADE;


--
-- Name: ballooning_characteristics ballooning_characteristics_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.ballooning_characteristics
    ADD CONSTRAINT ballooning_characteristics_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.ballooning_projects(id) ON DELETE CASCADE;


--
-- Name: ballooning_drawings ballooning_drawings_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.ballooning_drawings
    ADD CONSTRAINT ballooning_drawings_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.ballooning_projects(id) ON DELETE CASCADE;


--
-- Name: ballooning_inspections ballooning_inspections_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.ballooning_inspections
    ADD CONSTRAINT ballooning_inspections_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.ballooning_projects(id) ON DELETE CASCADE;


--
-- Name: quality_checks quality_checks_drawing_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.quality_checks
    ADD CONSTRAINT quality_checks_drawing_id_fkey FOREIGN KEY (drawing_id) REFERENCES public.quality_drawings(id) ON DELETE CASCADE;


--
-- Name: quality_dimensions quality_dimensions_drawing_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.quality_dimensions
    ADD CONSTRAINT quality_dimensions_drawing_id_fkey FOREIGN KEY (drawing_id) REFERENCES public.quality_drawings(id) ON DELETE CASCADE;


--
-- Name: quality_dispatches quality_dispatches_drawing_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.quality_dispatches
    ADD CONSTRAINT quality_dispatches_drawing_id_fkey FOREIGN KEY (drawing_id) REFERENCES public.quality_drawings(id) ON DELETE CASCADE;


--
-- Name: quality_measurements quality_measurements_check_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.quality_measurements
    ADD CONSTRAINT quality_measurements_check_id_fkey FOREIGN KEY (check_id) REFERENCES public.quality_checks(id) ON DELETE CASCADE;


--
-- Name: quality_measurements quality_measurements_dimension_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.quality_measurements
    ADD CONSTRAINT quality_measurements_dimension_id_fkey FOREIGN KEY (dimension_id) REFERENCES public.quality_dimensions(id) ON DELETE CASCADE;


--
-- Name: tally_export_files tally_export_files_export_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tally_export_files
    ADD CONSTRAINT tally_export_files_export_id_fkey FOREIGN KEY (export_id) REFERENCES public.tally_export_history(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict ehXNCB2pfvV2aBzrgoVyMT1WdwExEB7mUIbTAMT24yCeqjiIcbjojhTga6wU9UN

